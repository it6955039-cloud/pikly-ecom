/**
 * @file identity-mapping.service.ts
 * @layer Infrastructure / GIM (Global Identity Mapping)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALL BUGS FIXED IN THIS FILE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  BUG-DI  (CRITICAL) — Scope.REQUEST + SINGLETON injection = frozen GIM
 *    Root cause: @Injectable({ scope: Scope.REQUEST }) was set so that each
 *    HTTP request gets its own GIM instance with an isolated L1 cache. But
 *    ClerkProductionAdapter is a SINGLETON (created once at module init via
 *    useFactory), and ClerkWebhookController is also a SINGLETON (all NestJS
 *    controllers are singletons by default). When a SINGLETON injects a
 *    REQUEST-scoped provider, NestJS resolves it EXACTLY ONCE at startup and
 *    freezes that single instance for the lifetime of the application.
 *    Result:
 *      • All HTTP requests shared one GIM with a permanently-growing L1 cache.
 *      • User A's internalId could be served for User B's externalId lookup
 *        (cross-request identity leakage — security bug).
 *      • Memory leak: l1Cache.set() called on every request, delete() never
 *        actually cleared anything between requests.
 *      • Deactivated users could still resolve() successfully because their
 *        L1 cache entry was never evicted.
 *    Fix:
 *      • Changed to @Injectable() — default = Scope.DEFAULT = SINGLETON.
 *      • Removed the L1 Map cache entirely. A per-request cache is only safe
 *        when each request gets its own isolated GIM instance. As a singleton,
 *        any in-memory cache must be TTL-managed to avoid stale data — that
 *        complexity is not warranted for a simple indexed PK lookup.
 *      • resolve() now queries the DB on every call. The query hits the
 *        idx_im_external_id unique index — sub-millisecond on Neon PostgreSQL.
 *
 *  BUG-2   (CRITICAL) — Re-registration after Clerk delete → permanent 403
 *    Root cause: upsertMapping() ON CONFLICT DO UPDATE never set is_active=true,
 *    so a user deleted from Clerk who re-registered with the same email would
 *    have store.users.is_active = false forever → 403 on every API call.
 *    Fix: reactivate flag on UpsertMappingParams. When true (ONLY set by
 *    ClerkWebhookController.handleUserCreated), is_active = true is added to
 *    the ON CONFLICT DO UPDATE clause. JIT guard MUST NOT set this flag.
 *
 *  BUG-1/3 (CRITICAL) — Admin deactivation picked wrong mapping (LIMIT 1)
 *    Root cause: admin controller fetched externalId with LIMIT 1 JOIN which
 *    could pick an already-inactive mapping, leaving the active one alive.
 *    Fix: deactivateByInternalId() atomically deactivates ALL identity_mapping
 *    rows for the internal UUID. reactivateByInternalId() symmetric counterpart.
 *
 *  BUG-4   (HIGH) — auth_provider and clerk_id never persisted
 *    Root cause: INSERT into store.users omitted auth_provider and clerk_id
 *    columns. All Clerk users showed authProvider: 'legacy' in admin dashboard.
 *    Fix: both columns included in INSERT and ON CONFLICT DO UPDATE paths.
 *
 *  BUG-5   (HIGH) — L1 cache warmed on deactivated rows (now moot; cache removed)
 *    Resolved by BUG-DI fix above — L1 cache removed entirely.
 *
 *  BUG-PWD (MEDIUM) — password_hash set to NULL (breaks if migration 002 not run)
 *    Root cause: previous fix accidentally used NULL for password_hash.
 *    If ALTER COLUMN password_hash DROP NOT NULL hasn't been applied yet,
 *    every upsertMapping INSERT would throw a NOT NULL constraint violation,
 *    breaking provisioning for ALL new users.
 *    Fix: reverted to '$CLERK_MANAGED$' sentinel — safe whether or not the
 *    column is nullable.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service'

export interface UpsertMappingParams {
  externalId: string
  email:      string
  firstName:  string
  lastName:   string
  role:       'customer' | 'admin'
  avatarUrl?: string
  /**
   * BUG-2 FIX — When true, ON CONFLICT DO UPDATE sets is_active = true on
   * both store.users and store.identity_mapping.
   *
   * ONLY set by ClerkWebhookController.handleUserCreated() — represents a
   * genuine new Clerk account creation (user completed Clerk's sign-up flow).
   *
   * NEVER set by JitProvisioningGuard. JIT runs on every authenticated request;
   * allowing reactivate=true there would let a deactivated user bypass
   * deactivation by simply making any API call with a still-valid Clerk JWT.
   */
  reactivate?: boolean
}

interface MappingStateRow {
  internal_id: string
  is_active:   boolean
}

/**
 * BUG-DI FIX: @Injectable() = Scope.DEFAULT = SINGLETON.
 * See file-level comment for full explanation of why Scope.REQUEST was wrong.
 */
@Injectable()
export class IdentityMappingService {
  private readonly logger = new Logger(IdentityMappingService.name)

  constructor(private readonly db: DatabaseService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Resolve a Clerk external ID to an internal UUID.
   * Returns null if not found OR if the mapping is deactivated.
   *
   * BUG-DI FIX: L1 cache removed. Queries the DB on every call.
   * Performance: hits idx_im_external_id unique index — ~1ms on Neon.
   */
  async resolve(externalId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ internal_id: string }>(
      `SELECT internal_id
       FROM store.identity_mapping
       WHERE external_id = $1 AND is_active = true`,
      [externalId],
    )
    return row?.internal_id ?? null
  }

  async resolveOrThrow(externalId: string): Promise<string> {
    const id = await this.resolve(externalId)
    if (!id) {
      throw new NotFoundException({
        code:    'USER_NOT_PROVISIONED',
        message: `No active mapping found for external ID: ${externalId}. ` +
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
    if (!row) return false
    return row.is_active === false
  }

  async resolveBatch(externalIds: string[]): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map()

    const result = new Map<string, string>()

    const rows = await this.db.query<{ external_id: string; internal_id: string }>(
      `SELECT external_id, internal_id
       FROM store.identity_mapping
       WHERE external_id = ANY($1) AND is_active = true`,
      [externalIds],
    )

    for (const row of rows) {
      result.set(row.external_id, row.internal_id)
    }

    return result
  }

  /**
   * Idempotent upsert — called by JIT Guard, webhook handler, and admin ops.
   *
   * BUG-2 FIX:  reactivate flag conditionally adds is_active = true to the
   *   ON CONFLICT DO UPDATE clause. Only safe on the webhook user.created path.
   *
   * BUG-4 FIX:  auth_provider = 'clerk' and clerk_id = externalId now set in
   *   both INSERT and ON CONFLICT DO UPDATE. Previously all Clerk users showed
   *   authProvider: 'legacy' in the admin dashboard.
   *
   * BUG-PWD FIX: password_hash uses '$CLERK_MANAGED$' sentinel (safe for both
   *   nullable and NOT NULL columns — see file header for explanation).
   *
   * Returns the internal UUID (whether newly created or pre-existing).
   */
  async upsertMapping(params: UpsertMappingParams): Promise<string> {
    const { externalId, email, firstName, lastName, role, avatarUrl, reactivate = false } = params

    // BUG-2 FIX: only add is_active = true on genuine Clerk re-registration
    const reactivateClause = reactivate ? ', is_active = true' : ''

    const internalId = await this.db.transaction(async (client) => {
      // Step 1 — Upsert store.users
      const userRow = await client.query<{ id: string; xmax: string }>(
        `INSERT INTO store.users
           (email, password_hash, first_name, last_name, avatar, role,
            is_verified, is_active, auth_provider, clerk_id)
         VALUES ($1, '$CLERK_MANAGED$', $2, $3, $4, $5, true, true, 'clerk', $6)
         ON CONFLICT (email) DO UPDATE
           SET first_name    = EXCLUDED.first_name,
               last_name     = EXCLUDED.last_name,
               avatar        = COALESCE(EXCLUDED.avatar, store.users.avatar),
               role          = EXCLUDED.role,
               auth_provider = 'clerk',
               clerk_id      = EXCLUDED.clerk_id,
               updated_at    = NOW()
               ${reactivateClause}
         RETURNING id, xmax::text`,
        [email.toLowerCase(), firstName, lastName, avatarUrl ?? null, role, externalId],
      )

      const userId:    string  = userRow.rows[0].id
      const isInsert:  boolean = userRow.rows[0].xmax === '0'

      this.logger.debug(
        `[GIM] store.users ${isInsert ? 'INSERT' : 'UPDATE'} for ${email} → ${userId}`,
      )

      // Step 2 — Upsert store.identity_mapping
      if (reactivate) {
        // Genuine re-registration: restore is_active = true even if mapping was
        // previously deactivated by an admin or user.deleted webhook.
        await client.query(
          `INSERT INTO store.identity_mapping
             (external_id, internal_id, provider, email, is_active)
           VALUES ($1, $2, 'clerk', $3, true)
           ON CONFLICT (external_id) DO UPDATE
             SET internal_id = EXCLUDED.internal_id,
                 email       = EXCLUDED.email,
                 is_active   = true,
                 updated_at  = NOW()`,
          [externalId, userId, email.toLowerCase()],
        )
      } else {
        // Normal JIT / webhook update path.
        // Security invariant: do NOT touch is_active on conflict.
        // A deactivated user must NOT be able to self-reactivate via JIT.
        await client.query(
          `INSERT INTO store.identity_mapping
             (external_id, internal_id, provider, email, is_active)
           VALUES ($1, $2, 'clerk', $3, true)
           ON CONFLICT (external_id) DO UPDATE
             SET internal_id = EXCLUDED.internal_id,
                 email       = EXCLUDED.email,
                 updated_at  = NOW()`,
          [externalId, userId, email.toLowerCase()],
        )
      }

      return userId
    })

    this.logger.log(
      `[GIM] upsertMapping ${externalId} → ${internalId} (${email})` +
      `${reactivate ? ' [REACTIVATE]' : ''}`,
    )

    return internalId
  }

  /**
   * Deactivate by external Clerk ID — called by ClerkWebhookController.handleUserDeleted().
   *
   * BUG-1/3 FIX: Resolves internalId first, then deactivates ALL
   * identity_mapping rows for that internalId in one atomic transaction.
   * Previously only the one row matching externalId was deactivated — if the
   * user had re-registered and had 2 mapping rows, the new active one survived.
   */
  async deactivateMapping(externalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const mapping = await client.query<{ internal_id: string }>(
        `SELECT internal_id FROM store.identity_mapping WHERE external_id = $1 LIMIT 1`,
        [externalId],
      )

      if (mapping.rows.length === 0) {
        this.logger.debug(`[GIM] deactivateMapping: no mapping for ${externalId} — no-op`)
        return
      }

      const internalId = mapping.rows[0].internal_id

      // BUG-1/3 FIX: deactivate ALL rows for this user, not just the one row
      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = false, updated_at = NOW()
         WHERE internal_id = $1`,
        [internalId],
      )

      await client.query(
        `UPDATE store.users SET is_active = false, updated_at = NOW() WHERE id = $1`,
        [internalId],
      )
    })

    this.logger.log(`[GIM] Deactivated all mappings for externalId ${externalId}`)
  }

  /**
   * BUG-1/3 FIX — Atomically deactivate all mappings by internalId (admin path).
   *
   * Admin operations know the internal UUID, not the Clerk external ID. Using
   * internalId directly avoids the old LIMIT 1 JOIN ambiguity that could pick
   * an already-inactive mapping and leave the active one in place.
   *
   * Both store.users and ALL store.identity_mapping rows for the user are
   * updated in one transaction — no partial deactivation possible.
   *
   * Called by AdminUsersController.softDelete() and updateStatus(false).
   */
  async deactivateByInternalId(internalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = false, updated_at = NOW()
         WHERE internal_id = $1`,
        [internalId],
      )
      await client.query(
        `UPDATE store.users SET is_active = false, updated_at = NOW() WHERE id = $1`,
        [internalId],
      )
    })

    this.logger.log(`[GIM] deactivateByInternalId: deactivated all mappings for ${internalId}`)
  }

  /**
   * Atomically re-activate by internalId (admin path).
   * Activates the most recently updated mapping and restores the user record.
   *
   * Called by AdminUsersController.updateStatus(true).
   */
  async reactivateByInternalId(internalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      // Reactivate the most recent mapping row (handles re-registration edge case)
      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = true, updated_at = NOW()
         WHERE internal_id = $1
           AND id = (
             SELECT id FROM store.identity_mapping
             WHERE internal_id = $1
             ORDER BY updated_at DESC
             LIMIT 1
           )`,
        [internalId],
      )

      await client.query(
        `UPDATE store.users SET is_active = true, updated_at = NOW() WHERE id = $1`,
        [internalId],
      )
    })

    this.logger.log(`[GIM] reactivateByInternalId: reactivated user ${internalId}`)
  }

  /**
   * @deprecated Admin paths should use reactivateByInternalId().
   * Kept for backward compatibility with legacy callers.
   */
  async reactivateMapping(externalId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const mapping = await client.query<{ internal_id: string }>(
        `SELECT internal_id FROM store.identity_mapping WHERE external_id = $1 LIMIT 1`,
        [externalId],
      )
      if (mapping.rows.length === 0) return

      const internalId = mapping.rows[0].internal_id

      await client.query(
        `UPDATE store.identity_mapping
         SET is_active = true, updated_at = NOW()
         WHERE external_id = $1`,
        [externalId],
      )

      await client.query(
        `UPDATE store.users SET is_active = true, updated_at = NOW() WHERE id = $1`,
        [internalId],
      )
    })

    this.logger.log(`[GIM] reactivateMapping: reactivated ${externalId}`)
  }

  /**
   * Reverse lookup: internal UUID → most recent Clerk external ID.
   * Used by admin operations that need to call the Clerk API (e.g. session revocation).
   * Does NOT filter by is_active so it works even after deactivation.
   */
  async resolveExternal(internalId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ external_id: string }>(
      `SELECT external_id
       FROM store.identity_mapping
       WHERE internal_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [internalId],
    )
    return row?.external_id ?? null
  }
}
