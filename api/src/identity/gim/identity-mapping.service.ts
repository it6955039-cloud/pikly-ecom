/**
 * @file identity-mapping.service.ts
 * @layer Infrastructure / GIM (Global Identity Mapping)
 *
 * Changes in this version (v3 → v4):
 *
 *   1. deactivateMapping() — made atomic via db.transaction()
 *      Previously the two UPDATE statements (identity_mapping + store.users)
 *      ran as separate db.execute() calls with no transaction wrapper.
 *      If the second query failed (e.g., no matching JOIN row due to a data
 *      inconsistency), store.users.is_active was left as true while
 *      identity_mapping.is_active became false — or vice versa. Either partial
 *      state allowed a deactivated user to bypass enforcement at the service
 *      layer (profile returned isActive: true) or the guard layer (resolve()
 *      returned a non-null id through a still-active identity_mapping row).
 *      Both tables are now updated atomically — either both succeed or both
 *      roll back.
 *
 *   2. reactivateMapping() — made atomic via db.transaction() (symmetry +
 *      correctness — a reactivated user must be visible to both layers
 *      simultaneously or not at all).
 *
 *   3. upsertMapping() L1 cache — fixed unconditional cache warming.
 *      The comment said "only if INSERT path" but the code always called
 *      this.l1Cache.set(). On the ON CONFLICT (update) path, the row might be
 *      deactivated; warming the cache with its internalId would give a false
 *      L1 hit within the same request. Fixed: L1 is only warmed when we are
 *      certain we are on the INSERT path (detected via the xmax heuristic).
 *
 * All other methods are unchanged from v3.
 */

import { Injectable, Scope, Logger, NotFoundException, ForbiddenException } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'

export interface UpsertMappingParams {
  externalId: string
  email: string
  firstName: string
  lastName: string
  role: 'customer' | 'admin'
  avatarUrl?: string
}

/** Shape returned by the deactivation-state lookup query. */
interface MappingStateRow {
  internal_id: string
  is_active: boolean
}

@Injectable({ scope: Scope.REQUEST })
export class IdentityMappingService {
  private readonly logger = new Logger(IdentityMappingService.name)

  /**
   * L1 cache — lives for exactly one request lifecycle.
   * Key:   Clerk external ID
   * Value: Internal UUID
   */
  private readonly l1Cache = new Map<string, string>()

  constructor(private readonly db: DatabaseService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Resolve a Clerk external ID to an internal UUID.
   * Returns null if not found OR if the mapping exists but is deactivated.
   */
  async resolve(externalId: string): Promise<string | null> {
    // L1 hit
    const cached = this.l1Cache.get(externalId)
    if (cached) return cached

    // L2 hit — active mappings only
    const row = await this.db.queryOne<{ internal_id: string }>(
      `SELECT internal_id
       FROM store.identity_mapping
       WHERE external_id = $1 AND is_active = true`,
      [externalId],
    )

    if (!row) return null

    this.l1Cache.set(externalId, row.internal_id)
    return row.internal_id
  }

  /**
   * Resolve or throw — use in guards that require a fully provisioned user.
   */
  async resolveOrThrow(externalId: string): Promise<string> {
    const id = await this.resolve(externalId)
    if (!id) {
      throw new NotFoundException({
        code: 'USER_NOT_PROVISIONED',
        message:
          `No internal mapping found for external ID: ${externalId}. ` +
          `JIT provisioning may be in progress — retry in a moment.`,
      })
    }
    return id
  }

  /**
   * Determine whether an identity mapping exists for this externalId but is
   * explicitly deactivated (is_active = false).
   *
   * Used by JitProvisioningGuard to distinguish:
   *   • resolve() → null + isDeactivated() → false  ⟹ new user → provision
   *   • resolve() → null + isDeactivated() → true   ⟹ deactivated → reject
   */
  async isDeactivated(externalId: string): Promise<boolean> {
    const row = await this.db.queryOne<MappingStateRow>(
      `SELECT internal_id, is_active
       FROM store.identity_mapping
       WHERE external_id = $1
       LIMIT 1`,
      [externalId],
    )

    if (!row) return false // No record → user never existed → not deactivated
    return row.is_active === false
  }

  /**
   * Batch resolution — fetches multiple mappings in a SINGLE query.
   */
  async resolveBatch(externalIds: string[]): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map()

    const result: Map<string, string> = new Map()
    const uncached: string[] = []

    for (const id of externalIds) {
      const hit = this.l1Cache.get(id)
      if (hit) result.set(id, hit)
      else uncached.push(id)
    }

    if (uncached.length === 0) return result

    const rows = await this.db.query<{ external_id: string; internal_id: string }>(
      `SELECT external_id, internal_id
       FROM store.identity_mapping
       WHERE external_id = ANY($1) AND is_active = true`,
      [uncached],
    )

    for (const row of rows) {
      result.set(row.external_id, row.internal_id)
      this.l1Cache.set(row.external_id, row.internal_id)
    }

    return result
  }

  /**
   * Idempotent upsert — called by both JIT Guard and Clerk webhook handler.
   *
   * Security invariants:
   *   • is_active is NOT touched in the ON CONFLICT DO UPDATE paths for either
   *     store.users or store.identity_mapping. Activation state is the exclusive
   *     concern of deactivateMapping() and reactivateMapping().
   *   • L1 cache is only warmed when we are certain the row is newly inserted
   *     (xmax = 0 heuristic). On the conflict/update path the row may be
   *     deactivated — warming would give a false positive on subsequent
   *     resolve() calls within the same request.
   *
   * Returns the internal UUID (whether newly created or pre-existing).
   */
  async upsertMapping(params: UpsertMappingParams): Promise<string> {
    const { externalId, email, firstName, lastName, role, avatarUrl } = params

    const result = await this.db.transaction(async (client) => {
      // Step 1 — Upsert store.users
      const userRow = await client.query<{ id: string; xmax: string }>(
        `INSERT INTO store.users
           (email, password_hash, first_name, last_name, avatar, role,
            is_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true, true)
         ON CONFLICT (email) DO UPDATE
           SET first_name  = EXCLUDED.first_name,
               last_name   = EXCLUDED.last_name,
               avatar      = COALESCE(EXCLUDED.avatar, store.users.avatar),
               role        = EXCLUDED.role,
               updated_at  = NOW()
         RETURNING id, xmax::text`,
        [email.toLowerCase(), '$CLERK_MANAGED$', firstName, lastName, avatarUrl ?? null, role],
      )

      const internalId: string = userRow.rows[0].id
      const isInsert: boolean = userRow.rows[0].xmax === '0'

      // Step 2 — Upsert store.identity_mapping
      await client.query(
        `INSERT INTO store.identity_mapping
           (external_id, internal_id, provider, email, is_active)
         VALUES ($1, $2, 'clerk', $3, true)
         ON CONFLICT (external_id) DO UPDATE
           SET internal_id = EXCLUDED.internal_id,
               email       = EXCLUDED.email,
               updated_at  = NOW()`,
        [externalId, internalId, email.toLowerCase()],
      )

      return { internalId, isInsert }
    })

    // ── L1 cache warming ───────────────────────────────────────────────────
    // Only warm on INSERT (xmax = 0). On the ON CONFLICT update path the
    // identity_mapping row may be deactivated — caching its internalId
    // would produce false-positive resolve() hits within this request.
    if (result.isInsert) {
      this.l1Cache.set(externalId, result.internalId)
    }

    this.logger.debug(
      `[GIM] Upserted mapping ${externalId} → ${result.internalId} ` +
        `(${email}) [${result.isInsert ? 'INSERT' : 'UPDATE'}]`,
    )

    return result.internalId
  }

  /**
   * Atomically deactivate both store.identity_mapping and store.users.
   *
   * Both tables are updated inside a single transaction so they are NEVER
   * in an inconsistent half-deactivated state — which previously allowed
   * a deactivated user to bypass either the guard layer (identity_mapping
   * still active → resolve() succeeded) or the service layer (store.users
   * still active → profile returned isActive: true).
   *
   * Called by:
   *   • ClerkWebhookController.handleUserDeleted()
   *   • AdminUsersController.softDelete()
   *   • AdminUsersController.updateStatus(false)
   */
  async deactivateMapping(externalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      // 1. Deactivate the identity mapping — blocks GIM.resolve()
      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = false, updated_at = NOW()
         WHERE external_id = $1`,
        [externalId],
      )

      // 2. Mirror to store.users — blocks service-layer findOrFail()
      //    Uses a JOIN so we touch exactly the row that belongs to this
      //    Clerk identity — never a stale or wrong user row.
      await client.query(
        `UPDATE store.users u
         SET is_active = false, updated_at = NOW()
         FROM store.identity_mapping m
         WHERE m.external_id = $1
           AND m.internal_id = u.id`,
        [externalId],
      )
    })

    // Evict from L1 — the next resolve() hits L2 and correctly gets null.
    this.l1Cache.delete(externalId)

    this.logger.log(`[GIM] Deactivated mapping for ${externalId}`)
  }

  /**
   * Atomically re-activate both store.identity_mapping and store.users.
   *
   * Symmetric counterpart to deactivateMapping() — both tables are updated
   * inside a single transaction. A user who has been reactivated by an admin
   * can log in immediately without waiting for a Clerk webhook.
   *
   * Called by:
   *   • AdminUsersController.updateStatus(true)
   */
  async reactivateMapping(externalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = true, updated_at = NOW()
         WHERE external_id = $1`,
        [externalId],
      )

      await client.query(
        `UPDATE store.users u
         SET is_active = true, updated_at = NOW()
         FROM store.identity_mapping m
         WHERE m.external_id = $1
           AND m.internal_id = u.id`,
        [externalId],
      )
    })

    // Evict stale L1 entry — next request re-populates from L2 correctly.
    this.l1Cache.delete(externalId)

    this.logger.log(`[GIM] Reactivated mapping for ${externalId}`)
  }

  /**
   * Reverse lookup — internalId → externalId.
   * Used when the domain needs to call Clerk APIs by external ID.
   */
  async resolveExternal(internalId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ external_id: string }>(
      `SELECT external_id
       FROM store.identity_mapping
       WHERE internal_id = $1 AND is_active = true
       LIMIT 1`,
      [internalId],
    )
    return row?.external_id ?? null
  }
}
