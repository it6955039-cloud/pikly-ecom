/**
 * @file admin-users.controller.ts
 *
 * BUGS FIXED:
 *
 *   BUG-1 / BUG-3 FIX — softDelete() and updateStatus() now call
 *     gim.deactivateByInternalId() / gim.reactivateByInternalId() instead of
 *     fetching externalId with a LIMIT 1 JOIN and calling deactivateMapping /
 *     reactivateMapping. The old approach used LIMIT 1 which could pick an
 *     already-inactive mapping, leaving a newer active mapping in place.
 *     The new methods operate atomically on ALL mappings for the internal_id.
 *
 *   BUG-4 FIX — findAll() now uses DISTINCT ON (u.id) with ORDER BY
 *     im.updated_at DESC to prevent duplicate rows when a user has multiple
 *     active identity_mapping rows (edge case from Clerk re-registration before
 *     a user.deleted webhook was processed). Ensures the most recent active
 *     mapping populates the clerk_id column.
 *
 *   BUG-4b FIX — findOne() adds ORDER BY im.updated_at DESC NULLS LAST
 *     to consistently return the most recent active Clerk mapping.
 *
 *   BUG-8 FIX — updateStatus() and softDelete() were split-operations:
 *     first updating store.users, then separately calling GIM. If GIM threw,
 *     store.users was deactivated but identity_mapping stayed active (or
 *     vice-versa). Fixed: deactivateByInternalId() / reactivateByInternalId()
 *     wrap both tables in a single DB transaction.
 *
 *   CLEANUP — Removed unused imports: REQUEST, InternalServerErrorException.
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
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger'
import { ConfigService } from '@nestjs/config'
import { ModuleRef, ContextIdFactory } from '@nestjs/core'

import { DatabaseService } from '../database/database.service'
import { successResponse } from '../common/api-utils'
import { RequireRoleGuard } from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole } from '../identity/guards/identity.guards'
import { IdentityMappingService } from '../identity/gim/identity-mapping.service'

function safeUser(row: any) {
  if (!row) return null
  const { password_hash, ...rest } = row
  return {
    id: rest.id,
    email: rest.email,
    firstName: rest.first_name,
    lastName: rest.last_name,
    role: rest.role,
    isActive: rest.is_active,
    isVerified: rest.is_verified,
    loyaltyPoints: rest.loyalty_points,
    lastLogin: rest.last_login,
    createdAt: rest.created_at,
    authProvider: rest.auth_provider,
    clerkId: rest.clerk_id ?? null,
  }
}

@ApiTags('Admin — Users')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/users')
export class AdminUsersController {
  private readonly logger = new Logger(AdminUsersController.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ── List ──────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '[Admin] List all users with pagination and search' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'role', required: false })
  @ApiQuery({ name: 'isActive', required: false })
  @ApiQuery({ name: 'authProvider', required: false })
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('isActive') isActive?: string,
    @Query('authProvider') authProvider?: string,
  ) {
    const p = Math.max(1, parseInt(page ?? '1', 10))
    const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10)))
    const offset = (p - 1) * l

    const conditions: string[] = []
    const params: unknown[] = []

    if (search) {
      params.push(`%${search}%`)
      conditions.push(
        `(u.email ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length})`,
      )
    }
    if (role) {
      params.push(role)
      conditions.push(`u.role = $${params.length}`)
    }
    if (isActive) {
      params.push(isActive === 'true')
      conditions.push(`u.is_active = $${params.length}`)
    }
    if (authProvider) {
      params.push(authProvider)
      conditions.push(`u.auth_provider = $${params.length}`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    params.push(l, offset)

    // BUG-4 FIX: DISTINCT ON (u.id) prevents duplicate rows when a user has
    // multiple active identity_mapping rows (Clerk re-registration edge case).
    // ORDER BY im.updated_at DESC picks the most recently updated active mapping
    // to populate the clerk_id column.
    const rows = await this.db.query<any>(
      `SELECT DISTINCT ON (u.id)
              u.*,
              im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im
         ON im.internal_id = u.id
        AND im.is_active = true
       ${where}
       ORDER BY u.id, im.updated_at DESC NULLS LAST, u.created_at DESC
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
      page: p,
      limit: l,
    })
  }

  // ── Single user ───────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: '[Admin] Get single user by internal UUID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    // BUG-4b FIX: ORDER BY im.updated_at DESC NULLS LAST to consistently
    // return the most recent active Clerk mapping when multiple exist.
    const row = await this.db.queryOne<any>(
      `SELECT u.*,
              im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im
         ON im.internal_id = u.id
        AND im.is_active = true
       WHERE u.id = $1
       ORDER BY im.updated_at DESC NULLS LAST
       LIMIT 1`,
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
  async updateStatus(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException({
        code: 'INVALID_STATUS',
        message: 'isActive must be a boolean',
      })
    }

    const exists = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM store.users WHERE id = $1`,
      [id],
    )
    if (!exists) throw new NotFoundException({ code: 'USER_NOT_FOUND' })

    const gim = await this.resolveGim()

    // BUG-1 / BUG-3 / BUG-8 FIX:
    // Old code: fetched externalId with LIMIT 1 JOIN (could pick wrong mapping),
    //   then called store.users UPDATE separately from GIM — non-atomic.
    // New code: deactivateByInternalId / reactivateByInternalId are atomic
    //   transactions that update both tables in one operation.
    if (isActive) {
      await gim.reactivateByInternalId(id)
      this.logger.log(`[Admin] Reactivated user ${id}`)
    } else {
      await gim.deactivateByInternalId(id)
      this.logger.log(`[Admin] Deactivated user ${id}`)

      // Best-effort Clerk session revocation. resolveExternal() picks the
      // most recently updated active mapping AFTER deactivation (returns null
      // if all mappings were deactivated, which is the common case).
      // Note: deactivateByInternalId runs first, so resolveExternal may return
      // null here. Fall back to a direct DB lookup for session revocation only.
      const externalId = await this.resolveExternalForRevocation(id)
      if (externalId) {
        void this.revokeClerkSessions(externalId).catch((err: unknown) => {
          this.logger.warn(
            `[Admin] Clerk session revocation failed for ${externalId} ` +
              `(non-fatal): ${String(err)}`,
          )
        })
      }
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
  async updateRole(@Param('id') id: string, @Body('role') role: string) {
    if (!['customer', 'admin'].includes(role)) {
      throw new BadRequestException({
        code: 'INVALID_ROLE',
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
    summary: '[Admin] Soft-delete user',
    description:
      'Sets is_active = false on store.users and ALL store.identity_mapping rows ' +
      "atomically. Also revokes the user's active Clerk sessions (best-effort).",
  })
  @ApiParam({ name: 'id' })
  async softDelete(@Param('id') id: string) {
    const exists = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM store.users WHERE id = $1`,
      [id],
    )
    if (!exists) throw new NotFoundException({ code: 'USER_NOT_FOUND' })

    // Look up externalId BEFORE deactivation (while mapping is still active)
    const externalId = await this.resolveExternalForRevocation(id)

    const gim = await this.resolveGim()

    // BUG-1 / BUG-3 / BUG-8 FIX:
    // Old code: separate store.users UPDATE + gim.deactivateMapping(externalId)
    //   with LIMIT 1 JOIN — non-atomic and could pick wrong mapping.
    // New code: deactivateByInternalId atomically deactivates both tables
    //   for ALL mappings belonging to this internal_id.
    await gim.deactivateByInternalId(id)
    this.logger.log(`[Admin] Soft-deleted user ${id} — all identity mappings deactivated`)

    if (externalId) {
      void this.revokeClerkSessions(externalId).catch((err: unknown) => {
        this.logger.warn(
          `[Admin] Clerk session revocation failed for ${externalId} ` +
            `(non-fatal — account is deactivated in DB): ${String(err)}`,
        )
      })
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async resolveGim(): Promise<IdentityMappingService> {
    const contextId = ContextIdFactory.create()
    return this.moduleRef.resolve(IdentityMappingService, contextId, { strict: false })
  }

  /**
   * Fetch the most recent active Clerk external_id for session revocation.
   * Called before deactivation so the mapping is still findable.
   */
  private async resolveExternalForRevocation(internalId: string): Promise<string | null> {
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

  private async revokeClerkSessions(externalId: string): Promise<void> {
    const secretKey = this.config.get<string>('CLERK_SECRET_KEY')
    if (!secretKey) {
      this.logger.warn('[Admin] CLERK_SECRET_KEY not set — skipping session revocation')
      return
    }

    const listResp = await fetch(`https://api.clerk.com/v1/users/${externalId}/sessions`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
    })

    if (!listResp.ok) {
      const body = await listResp.text().catch(() => '<unreadable>')
      this.logger.warn(
        `[Admin] Clerk session list returned ${listResp.status} for ${externalId}: ${body}`,
      )
      return
    }

    const sessions = (await listResp.json()) as Array<{ id: string; status: string }>
    const active = sessions.filter((s) => s.status === 'active')

    if (active.length === 0) {
      this.logger.debug(`[Admin] No active Clerk sessions found for ${externalId}`)
      return
    }

    const results = await Promise.allSettled(
      active.map((session) =>
        fetch(`https://api.clerk.com/v1/sessions/${session.id}/revoke`, {
          method: 'POST',
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
      this.logger.log(`[Admin] Revoked ${active.length} Clerk session(s) for ${externalId}`)
    }
  }
}
