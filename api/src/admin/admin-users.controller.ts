/**
 * @file admin-users.controller.ts
 * @layer Application / Controller
 *
 * Admin Users Controller — RBAC via RequireRoleGuard + JitProvisioningGuard.
 *
 * Security fix (v2 → v3):
 *   Previous implementation only wrote to store.users on status changes and
 *   soft-deletes, leaving store.identity_mapping.is_active untouched. Because
 *   JitProvisioningGuard resolves users through identity_mapping, a deactivated
 *   user whose identity_mapping row remained active could bypass the deactivation
 *   entirely — GIM.resolve() would succeed and the guard would proceed normally.
 *
 *   Changes in this version:
 *     1. softDelete  — deactivates both store.users AND store.identity_mapping
 *                      atomically. Then revokes all active Clerk sessions so the
 *                      user cannot continue using existing JWTs. Best-effort —
 *                      the DB deactivation is the authoritative gate; Clerk
 *                      session revocation is defence-in-depth.
 *
 *     2. updateStatus — mirrors is_active changes to identity_mapping so the GIM
 *                       layer always reflects the correct account state. On
 *                       deactivation, also revokes active Clerk sessions.
 *                       On reactivation, also reactivates the identity_mapping
 *                       row via GIM.reactivateMapping() so the user can log in
 *                       immediately without waiting for a webhook.
 *
 *   The IdentityMappingService (GIM) methods are resolved via ModuleRef because
 *   GIM is REQUEST-scoped; direct injection into a SINGLETON controller is
 *   disallowed by NestJS. The ContextIdFactory pattern used here mirrors the
 *   approach in JitProvisioningGuard — a single, well-understood idiom across
 *   the identity layer.
 */

import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger'
import { ConfigService }           from '@nestjs/config'
import { ModuleRef, ContextIdFactory } from '@nestjs/core'
import { REQUEST }                 from '@nestjs/core'

import { DatabaseService }         from '../database/database.service'
import { successResponse }         from '../common/api-utils'
import { RequireRoleGuard }        from '../identity/guards/identity.guards'
import { JitProvisioningGuard }    from '../identity/jit/jit-provisioning.guard'
import { RequireRole }             from '../identity/guards/identity.guards'
import { IdentityMappingService }  from '../identity/gim/identity-mapping.service'

// ── Response shape helpers ────────────────────────────────────────────────────

/**
 * Strip password_hash before sending any user row to the client.
 * This helper is intentionally kept as a plain function (not a class method)
 * so it can be reused across all handlers without a `this` binding.
 */
function safeUser(row: any) {
  if (!row) return null
  const { password_hash, ...rest } = row
  return {
    id:            rest.id,
    email:         rest.email,
    firstName:     rest.first_name,
    lastName:      rest.last_name,
    role:          rest.role,
    isActive:      rest.is_active,
    isVerified:    rest.is_verified,
    loyaltyPoints: rest.loyalty_points,
    lastLogin:     rest.last_login,
    createdAt:     rest.created_at,
    authProvider:  rest.auth_provider,  // 'clerk' | 'legacy'
    clerkId:       rest.clerk_id ?? null,
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('Admin — Users')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/users')
export class AdminUsersController {
  private readonly logger = new Logger(AdminUsersController.name)

  constructor(
    private readonly db:        DatabaseService,
    private readonly config:    ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── List ──────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '[Admin] List all users with pagination and search' })
  @ApiQuery({ name: 'page',         required: false })
  @ApiQuery({ name: 'limit',        required: false })
  @ApiQuery({ name: 'search',       required: false })
  @ApiQuery({ name: 'role',         required: false })
  @ApiQuery({ name: 'isActive',     required: false })
  @ApiQuery({ name: 'authProvider', required: false, description: 'Filter by clerk | legacy' })
  async findAll(
    @Query('page')         page?:         string,
    @Query('limit')        limit?:        string,
    @Query('search')       search?:       string,
    @Query('role')         role?:         string,
    @Query('isActive')     isActive?:     string,
    @Query('authProvider') authProvider?: string,
  ) {
    const p      = Math.max(1, parseInt(page  ?? '1',  10))
    const l      = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10)))
    const offset = (p - 1) * l

    const conditions: string[]  = []
    const params:     unknown[] = []

    if (search) {
      params.push(`%${search}%`)
      conditions.push(
        `(u.email ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length})`,
      )
    }
    if (role)         { params.push(role);                conditions.push(`u.role = $${params.length}`) }
    if (isActive)     { params.push(isActive === 'true'); conditions.push(`u.is_active = $${params.length}`) }
    if (authProvider) { params.push(authProvider);        conditions.push(`u.auth_provider = $${params.length}`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    params.push(l, offset)
    const rows = await this.db.query<any>(
      `SELECT u.*, im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im
         ON im.internal_id = u.id AND im.is_active = true
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )

    const [{ count }] = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM store.users u ${where}`,
      params.slice(0, params.length - 2),
    )

    return successResponse({
      users: rows.map(safeUser),
      total: parseInt(count, 10),
      page:  p,
      limit: l,
    })
  }

  // ── Single user ───────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: '[Admin] Get single user by internal UUID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const row = await this.db.queryOne<any>(
      `SELECT u.*, im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im
         ON im.internal_id = u.id AND im.is_active = true
       WHERE u.id = $1`,
      [id],
    )
    if (!row) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse(safeUser(row))
  }

  // ── Status toggle ─────────────────────────────────────────────────────────

  @Patch(':id/status')
  @ApiOperation({ summary: '[Admin] Toggle user active/inactive status' })
  @ApiParam({ name: 'id' })
  @ApiBody({ schema: { properties: { isActive: { type: 'boolean' } } } })
  async updateStatus(
    @Param('id')              id:       string,
    @Body('isActive')         isActive: boolean,
  ) {
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException({
        code:    'INVALID_STATUS',
        message: 'isActive must be a boolean',
      })
    }

    // Fetch the user's Clerk external_id alongside the row we're about to update.
    // We need the external_id to:
    //   a) sync is_active to identity_mapping via GIM
    //   b) revoke Clerk sessions on deactivation (best-effort)
    const user = await this.db.queryOne<{ id: string; external_id: string | null }>(
      `SELECT u.id, im.external_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im ON im.internal_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [id],
    )
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })

    // 1. Update store.users
    await this.db.execute(
      `UPDATE store.users SET is_active = $1, updated_at = NOW() WHERE id = $2`,
      [isActive, id],
    )

    // 2. Mirror the state change to identity_mapping so GIM resolution
    //    reflects the new status on the very next request.
    if (user.external_id) {
      const gim = await this.resolveGim()

      if (isActive) {
        await gim.reactivateMapping(user.external_id)
        this.logger.log(`[Admin] Reactivated identity mapping for user ${id} (${user.external_id})`)
      } else {
        await gim.deactivateMapping(user.external_id)
        this.logger.log(`[Admin] Deactivated identity mapping for user ${id} (${user.external_id})`)

        // 3. Revoke active Clerk sessions — best-effort, does not affect the
        //    DB deactivation which is the authoritative enforcement gate.
        void this.revokeClerkSessions(user.external_id).catch((err: unknown) => {
          this.logger.warn(
            `[Admin] Clerk session revocation failed for ${user.external_id} ` +
            `(non-fatal — account is already deactivated in DB): ${String(err)}`,
          )
        })
      }
    } else {
      // Legacy user with no Clerk mapping — only the store.users update applies.
      this.logger.debug(`[Admin] User ${id} has no Clerk mapping; skipping GIM sync`)
    }

    return successResponse({
      id,
      isActive,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
    })
  }

  // ── Role change ───────────────────────────────────────────────────────────

  @Patch(':id/role')
  @ApiOperation({ summary: '[Admin] Change user role (customer ↔ admin)' })
  @ApiParam({ name: 'id' })
  @ApiBody({ schema: { properties: { role: { type: 'string', enum: ['customer', 'admin'] } } } })
  async updateRole(
    @Param('id')   id:   string,
    @Body('role')  role: string,
  ) {
    if (!['customer', 'admin'].includes(role)) {
      throw new BadRequestException({
        code:    'INVALID_ROLE',
        message: 'role must be one of: customer, admin',
      })
    }

    const affected = await this.db.execute(
      `UPDATE store.users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, id],
    )
    if (!affected) throw new NotFoundException({ code: 'USER_NOT_FOUND' })

    return successResponse({ id, role })
  }

  // ── Soft delete ───────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:     '[Admin] Soft-delete user',
    description: 'Sets is_active = false on both store.users and store.identity_mapping. ' +
                 'Also revokes the user\'s active Clerk sessions (best-effort). ' +
                 'Historical data (orders, reviews) is preserved for audit integrity.',
  })
  @ApiParam({ name: 'id' })
  async softDelete(@Param('id') id: string) {
    // Resolve the Clerk external_id before we deactivate anything —
    // we need it for both GIM sync and Clerk session revocation.
    const user = await this.db.queryOne<{ id: string; external_id: string | null }>(
      `SELECT u.id, im.external_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im ON im.internal_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      [id],
    )
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })

    // 1. Deactivate store.users (authoritative gate)
    await this.db.execute(
      `UPDATE store.users SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id],
    )

    // 2. Deactivate identity_mapping so GIM.resolve() returns null on the
    //    next request and the JIT guard's isDeactivated() check fires correctly.
    if (user.external_id) {
      const gim = await this.resolveGim()
      await gim.deactivateMapping(user.external_id)
      this.logger.log(`[Admin] Soft-deleted user ${id} — identity mapping deactivated`)

      // 3. Revoke active Clerk sessions — best-effort.
      //    Even if this fails, the user's next API request will be rejected by
      //    the JIT guard (isDeactivated → ACCOUNT_DEACTIVATED). However, revoking
      //    sessions provides immediate invalidation of any in-flight JWTs and is
      //    worth the best-effort attempt.
      void this.revokeClerkSessions(user.external_id).catch((err: unknown) => {
        this.logger.warn(
          `[Admin] Clerk session revocation failed for ${user.external_id} ` +
          `(non-fatal — account is deactivated in DB): ${String(err)}`,
        )
      })
    } else {
      // Legacy user — only the store.users + identity_mapping DB updates apply.
      await this.db.execute(
        `UPDATE store.identity_mapping
         SET is_active = false, updated_at = NOW()
         WHERE internal_id = $1`,
        [id],
      )
      this.logger.log(`[Admin] Soft-deleted legacy user ${id} (no Clerk mapping)`)
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the REQUEST-scoped IdentityMappingService for the current request.
   *
   * GIM is REQUEST-scoped to keep its L1 cache isolated per request.
   * Controllers are SINGLETON — direct injection is disallowed by NestJS.
   * We use ModuleRef.resolve() with a synthetic context ID so we get the
   * same GIM instance that the JIT guard and middleware use for this request.
   *
   * NOTE: Admin endpoints are authenticated admin sessions, not user JWTs,
   * so there is no "current user's" GIM instance to share — we create a
   * fresh one tied to this admin request. That is correct and expected.
   */
  private async resolveGim(): Promise<IdentityMappingService> {
    const contextId = ContextIdFactory.create()
    return this.moduleRef.resolve(IdentityMappingService, contextId, {
      strict: false,
    })
  }

  /**
   * Revoke all active Clerk sessions for a given external (Clerk) user ID.
   *
   * Strategy:
   *   1. Fetch the user's active sessions via Clerk management API.
   *   2. Revoke each session individually (Clerk does not offer a bulk endpoint).
   *   3. Use Promise.allSettled so a single failed revocation does not abort
   *      the rest — partial revocation is better than no revocation.
   *
   * This is intentionally best-effort. The authoritative deactivation gate is
   * the identity_mapping.is_active flag checked by JitProvisioningGuard. Session
   * revocation provides defence-in-depth for clients that cache JWTs locally.
   *
   * Clerk API reference:
   *   GET  /v1/users/{userId}/sessions
   *   POST /v1/sessions/{sessionId}/revoke
   *
   * @throws — intentionally propagates errors so callers can log and suppress.
   */
  private async revokeClerkSessions(externalId: string): Promise<void> {
    const secretKey = this.config.get<string>('CLERK_SECRET_KEY')
    if (!secretKey) {
      this.logger.warn('[Admin] CLERK_SECRET_KEY not set — skipping session revocation')
      return
    }

    const listResp = await fetch(
      `https://api.clerk.com/v1/users/${externalId}/sessions`,
      {
        method:  'GET',
        headers: { Authorization: `Bearer ${secretKey}` },
      },
    )

    if (!listResp.ok) {
      const body = await listResp.text().catch(() => '<unreadable>')
      this.logger.warn(
        `[Admin] Clerk session list returned ${listResp.status} for ${externalId}: ${body}`,
      )
      return
    }

    const sessions = (await listResp.json()) as Array<{ id: string; status: string }>
    const active   = sessions.filter((s) => s.status === 'active')

    if (active.length === 0) {
      this.logger.debug(`[Admin] No active Clerk sessions found for ${externalId}`)
      return
    }

    const results = await Promise.allSettled(
      active.map((session) =>
        fetch(`https://api.clerk.com/v1/sessions/${session.id}/revoke`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
        }),
      ),
    )

    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      this.logger.warn(
        `[Admin] ${failed}/${active.length} Clerk session revocations failed for ${externalId}`,
      )
    } else {
      this.logger.log(
        `[Admin] Revoked ${active.length} Clerk session(s) for ${externalId}`,
      )
    }
  }
}
