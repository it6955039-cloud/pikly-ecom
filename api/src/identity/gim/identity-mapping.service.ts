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
 * SOLID:
 *   S — only handles Clerk↔UUID resolution
 *   D — depends on DatabaseService abstraction, not raw pg Client
 */

import {
  Injectable,
  Scope,
  Logger,
  NotFoundException,
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
   * Hits L1 first, then L2 (DB). Returns null if not found.
   * Does NOT trigger JIT provisioning — that is the JitProvisioningGuard's job.
   */
  async resolve(externalId: string): Promise<string | null> {
    // L1 hit
    const cached = this.l1Cache.get(externalId)
    if (cached) return cached

    // L2 hit
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
   * Batch resolution — fetches multiple mappings in a SINGLE query.
   * Use in list endpoints that return user-related data to prevent N+1.
   *
   * @returns Map<externalId, internalId>
   */
  async resolveBatch(
    externalIds: string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map()

    const result = new Map<string, string>()
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

    // Single DB query for all cache misses
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
     *   1. Upsert into store.users (creates the UUID primary key if absent)
     *   2. Upsert into store.identity_mapping (maps external → internal)
     *
     * Both use ON CONFLICT DO UPDATE so concurrent calls are idempotent.
     * The identity_mapping.external_id has a UNIQUE constraint.
     */
    const result = await this.db.transaction(async (client) => {
      // Step 1: Create or update user in store.users
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
               is_active   = true,
               updated_at  = NOW()
         RETURNING id`,
        [
          email.toLowerCase(),
          // Legacy password_hash placeholder — Clerk users never use password auth
          '$CLERK_MANAGED$',
          firstName,
          lastName,
          avatarUrl ?? null,
          role,
        ],
      )

      const internalId: string = userRow.rows[0].id

      // Step 2: Map the Clerk external ID to the internal UUID
      await client.query(
        `INSERT INTO store.identity_mapping
           (external_id, internal_id, provider, email, is_active)
         VALUES ($1, $2, 'clerk', $3, true)
         ON CONFLICT (external_id) DO UPDATE
           SET internal_id = EXCLUDED.internal_id,
               email       = EXCLUDED.email,
               is_active   = true,
               updated_at  = NOW()`,
        [externalId, internalId, email.toLowerCase()],
      )

      return internalId
    })

    // Warm L1 cache
    this.l1Cache.set(externalId, result)

    this.logger.debug(
      `[GIM] Mapped ${externalId} → ${result} (${email})`,
    )

    return result
  }

  /**
   * Soft-delete the mapping when a user is deleted in Clerk.
   * Does NOT delete store.users — preserves historical data integrity.
   */
  async deactivateMapping(externalId: string): Promise<void> {
    await this.db.execute(
      `UPDATE store.identity_mapping
       SET is_active = false, updated_at = NOW()
       WHERE external_id = $1`,
      [externalId],
    )
    // Also deactivate the user record
    await this.db.execute(
      `UPDATE store.users u
       SET is_active = false, updated_at = NOW()
       FROM store.identity_mapping m
       WHERE m.external_id = $1 AND m.internal_id = u.id`,
      [externalId],
    )
    this.l1Cache.delete(externalId)
  }

  /**
   * Reverse lookup — internalId → externalId.
   * Used when the domain needs to call back to Clerk APIs.
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
