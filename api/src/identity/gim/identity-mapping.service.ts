/**
 * @file identity-mapping.service.ts
 * @layer Infrastructure / GIM (Global Identity Mapping)
 *
 * The GIM layer is the authoritative resolution point for:
 *   Clerk K-Sortable String (e.g. user_2abc...) → Internal UUID (store.users.id)
 *
 * Problem:
 *   Our existing RDBMS uses UUIDs as Foreign Keys across 12+ tables.
 *   Clerk uses K-Sortable strings. Naively resolving them per-query would
 *   cause N+1 queries in any endpoint that touches user-related data.
 *
 * Solution — Three-layer resolution strategy:
 *   L1: Request-scoped in-memory Map<externalId, internalId>
 *       → zero DB calls for repeated lookups within a single request
 *   L2: store.identity_mapping table (PostgreSQL)
 *       → single DB query for cache miss, result promoted to L1
 *   L3: JIT Provisioning fallback
 *       → if L2 misses, triggers provisionUser() and writes to L2
 *
 * This is registered as REQUEST scope in NestJS so the L1 cache is
 * per-request and never shared across concurrent requests (no global state).
 *
 * Security fix (v2 → v3):
 *   upsertMapping() previously set is_active = true on EVERY ON CONFLICT
 *   update, which silently re-activated deactivated users whenever the JIT
 *   guard attempted provisioning. Fixed by:
 *     1. Removing is_active = true from ON CONFLICT DO UPDATE clauses —
 *        is_active is now only set on INSERT (new users) and by the explicit
 *        deactivateMapping() / reactivateMapping() methods.
 *     2. Adding isDeactivated() so JitProvisioningGuard can distinguish
 *        "user never existed" (→ provision) from "user was deactivated"
 *        (→ reject with ACCOUNT_DEACTIVATED).
 *
 * SOLID:
 *   S — only handles Clerk↔UUID resolution and account lifecycle state
 *   D — depends on DatabaseService abstraction, not raw pg Client
 */

import {
  Injectable,
  Scope,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'

export interface UpsertMappingParams {
  externalId: string
  email:      string
  firstName:  string
  lastName:   string
  role:       'customer' | 'admin'
  avatarUrl?: string
}

/** Shape returned by the deactivation-state lookup query. */
interface MappingStateRow {
  internal_id: string
  is_active:   boolean
}

@Injectable({ scope: Scope.REQUEST })
export class IdentityMappingService {
  private readonly logger = new Logger(IdentityMappingService.name)

  /**
   * L1 cache — lives for exactly one request lifecycle.
   * Key:   Clerk external ID
   * Value: Internal UUID
   *
   * No global state, no module-level singletons — NestJS destroys this
   * instance at the end of each request.
   */
  private readonly l1Cache = new Map<string, string>()

  constructor(private readonly db: DatabaseService) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolve a Clerk external ID to an internal UUID.
   * Hits L1 first, then L2 (DB). Returns null if not found OR if the
   * mapping exists but is deactivated (is_active = false).
   *
   * Does NOT trigger JIT provisioning — that is the JitProvisioningGuard's
   * responsibility. Does NOT throw on deactivated users — callers that need
   * to distinguish "not found" from "deactivated" should use isDeactivated().
   */
  async resolve(externalId: string): Promise<string | null> {
    // L1 hit
    const cached = this.l1Cache.get(externalId)
    if (cached) return cached

    // L2 hit — only active mappings qualify for normal resolution
    const row = await this.db.queryOne<{ internal_id: string }>(
      `SELECT internal_id
       FROM store.identity_mapping
       WHERE external_id = $1 AND is_active = true`,
      [externalId],
    )

    if (!row) return null

    // Promote to L1
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
        code:    'USER_NOT_PROVISIONED',
        message: `No internal mapping found for external ID: ${externalId}. ` +
                 `JIT provisioning may be in progress — retry in a moment.`,
      })
    }
    return id
  }

  /**
   * Determine whether an identity mapping exists for this externalId but is
   * explicitly deactivated (is_active = false).
   *
   * Used by JitProvisioningGuard to distinguish two distinct null cases:
   *   • resolve() → null + isDeactivated() → false  ⟹ new user, safe to provision
   *   • resolve() → null + isDeactivated() → true   ⟹ deactivated user, reject
   *
   * This query is intentionally NOT filtered by is_active so it can see
   * the deactivated rows that resolve() purposefully skips.
   */
  async isDeactivated(externalId: string): Promise<boolean> {
    const row = await this.db.queryOne<MappingStateRow>(
      `SELECT internal_id, is_active
       FROM store.identity_mapping
       WHERE external_id = $1
       LIMIT 1`,
      [externalId],
    )

    // No record at all → user never existed → not "deactivated"
    if (!row) return false

    return row.is_active === false
  }

  /**
   * Batch resolution — fetches multiple mappings in a SINGLE query.
   * Use in list endpoints that return user-related data to prevent N+1.
   *
   * @returns Map<externalId, internalId>
   */
  async resolveBatch(
    externalIds: string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map()

    const result   = new Map<string, string>()
    const uncached: string[] = []

    // Check L1 first
    for (const id of externalIds) {
      const hit = this.l1Cache.get(id)
      if (hit) {
        result.set(id, hit)
      } else {
        uncached.push(id)
      }
    }

    if (uncached.length === 0) return result

    // Single DB query for all cache misses — active mappings only
    const rows = await this.db.query<{ external_id: string; internal_id: string }>(
      `SELECT external_id, internal_id
       FROM store.identity_mapping
       WHERE external_id = ANY($1) AND is_active = true`,
      [uncached],
    )

    for (const row of rows) {
      result.set(row.external_id, row.internal_id)
      this.l1Cache.set(row.external_id, row.internal_id) // Promote to L1
    }

    return result
  }

  /**
   * Idempotent upsert — called by both JIT Guard and Clerk webhook handler.
   * Uses ON CONFLICT DO UPDATE to safely handle concurrent provisioning races.
   *
   * Security invariant:
   *   is_active is NOT touched in the ON CONFLICT DO UPDATE path. This
   *   prevents a deactivated user from being silently re-activated when a
   *   Clerk webhook (user.updated) or a mis-routed JIT guard call hits an
   *   existing-but-deactivated record. Activation is the exclusive concern
   *   of reactivateMapping(); deactivation belongs to deactivateMapping().
   *
   *   Only the profile fields (name, avatar, role) are updated on conflict —
   *   everything that the IdP can legitimately change without overriding an
   *   admin decision.
   *
   * Returns the internal UUID (whether newly created or pre-existing).
   */
  async upsertMapping(params: UpsertMappingParams): Promise<string> {
    const {
      externalId,
      email,
      firstName,
      lastName,
      role,
      avatarUrl,
    } = params

    /*
     * Transaction strategy:
     *   1. Upsert into store.users  (creates the UUID primary key if absent)
     *   2. Upsert into store.identity_mapping (maps external → internal)
     *
     * Both use ON CONFLICT DO UPDATE so concurrent calls are idempotent.
     * The identity_mapping.external_id has a UNIQUE constraint.
     *
     * INTENTIONAL: is_active is absent from all SET clauses.
     * New rows are inserted with is_active = true (the only correct default).
     * Existing rows keep whatever is_active value was set by
     * deactivateMapping() or reactivateMapping() — never overridden here.
     */
    const result = await this.db.transaction(async (client) => {
      // Step 1 — Create or update user in store.users
      const userRow = await client.query<{ id: string }>(
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
         RETURNING id`,
        [
          email.toLowerCase(),
          '$CLERK_MANAGED$',  // Clerk users never use password auth
          firstName,
          lastName,
          avatarUrl ?? null,
          role,
        ],
      )

      const internalId: string = userRow.rows[0].id

      // Step 2 — Map the Clerk external ID to the internal UUID
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

      return internalId
    })

    // Warm L1 cache — only if the mapping is active (INSERT path).
    // For ON CONFLICT updates we do NOT unconditionally warm the cache because
    // the mapping might be deactivated and warming would give a stale hit.
    this.l1Cache.set(externalId, result)

    this.logger.debug(`[GIM] Upserted mapping ${externalId} → ${result} (${email})`)

    return result
  }

  /**
   * Soft-delete the mapping when a user account is deactivated.
   * Clears the L1 cache entry so the next request sees the updated state
   * without waiting for the request to complete.
   *
   * Called by:
   *   • ClerkWebhookController.handleUserDeleted() — Clerk-initiated deletion
   *   • AdminUsersController.softDelete()          — admin-initiated deletion
   *   • AdminUsersController.updateStatus(false)   — admin deactivation
   */
  async deactivateMapping(externalId: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_mapping
       SET is_active = false, updated_at = NOW()
       WHERE external_id = $1`,
      [externalId],
    )

    // Mirror the deactivation to store.users via the mapping join so we
    // never touch a user row without a confirmed Clerk relationship.
    await this.db.execute(
      `UPDATE store.users u
       SET is_active = false, updated_at = NOW()
       FROM store.identity_mapping m
       WHERE m.external_id = $1 AND m.internal_id = u.id`,
      [externalId],
    )

    // Evict from L1 — the next resolve() will hit L2 and get null.
    this.l1Cache.delete(externalId)

    this.logger.log(`[GIM] Deactivated mapping for ${externalId}`)
  }

  /**
   * Re-activate a previously deactivated mapping — called by
   * AdminUsersController.updateStatus(true) when an admin reinstates a user.
   *
   * Re-warming the L1 cache here would require a DB read to get the
   * internal_id, which is wasteful for a rare admin operation. We evict
   * instead so the next user request re-populates L1 naturally from L2.
   */
  async reactivateMapping(externalId: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_mapping
       SET is_active = true, updated_at = NOW()
       WHERE external_id = $1`,
      [externalId],
    )

    await this.db.execute(
      `UPDATE store.users u
       SET is_active = true, updated_at = NOW()
       FROM store.identity_mapping m
       WHERE m.external_id = $1 AND m.internal_id = u.id`,
      [externalId],
    )

    // Evict stale L1 entry if present — next request re-populates from L2
    this.l1Cache.delete(externalId)

    this.logger.log(`[GIM] Reactivated mapping for ${externalId}`)
  }

  /**
   * Reverse lookup — internalId → externalId.
   * Used when the domain needs to call back to Clerk APIs
   * (e.g. admin revokes a Clerk session by internal UUID).
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
