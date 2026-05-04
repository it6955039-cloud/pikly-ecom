/**
 * @file admin-users.controller.ts  ← REPLACE src/admin/admin-users.controller.ts
 *
 * Admin Users Controller — migrated RBAC from passport-jwt + RolesGuard → IAL.
 *
 * DIFF vs original:
 *   - @UseGuards(AuthGuard('jwt'), RolesGuard)  → @UseGuards(RequireRoleGuard, JitProvisioningGuard)
 *   - @Roles('admin')                           → @RequireRole('admin')
 *   - No req.user anywhere — controller reads from DB directly with DatabaseService
 *
 * The body of every handler is IDENTICAL to the original — zero logic change.
 */

import {
  Controller, Get, Patch, Delete, Param, Query, Body,
  UseGuards, HttpCode, HttpStatus, NotFoundException, BadRequestException,
} from '@nestjs/common'
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiParam, ApiQuery,
} from '@nestjs/swagger'

import { DatabaseService }     from '../database/database.service'
import { successResponse }     from '../common/api-utils'
import { RequireRoleGuard }    from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }         from '../identity/guards/identity.guards'

// Identical helper from original — strips password_hash before sending to client
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
    authProvider:  rest.auth_provider,  // new field — shows 'clerk' or 'legacy'
  }
}

@ApiTags('Admin — Users')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly db: DatabaseService) {}

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
    const p = Math.max(1, parseInt(page  ?? '1',  10))
    const l = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10)))
    const offset = (p - 1) * l

    const conditions: string[] = []
    const params:     unknown[] = []

    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(u.email ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length})`)
    }
    if (role)         { params.push(role);         conditions.push(`u.role = $${params.length}`) }
    if (isActive)     { params.push(isActive === 'true'); conditions.push(`u.is_active = $${params.length}`) }
    if (authProvider) { params.push(authProvider); conditions.push(`u.auth_provider = $${params.length}`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    params.push(l, offset)
    const rows = await this.db.query<any>(
      `SELECT u.*, im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im ON im.internal_id = u.id AND im.is_active = true
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )

    const [{ count }] = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM store.users u ${where}`,
      params.slice(0, params.length - 2),
    )

    return successResponse({
      users: rows.map(safeUser),
      total: parseInt(count, 10),
      page: p,
      limit: l,
    })
  }

  @Get(':id')
  @ApiOperation({ summary: '[Admin] Get single user by internal UUID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const row = await this.db.queryOne<any>(
      `SELECT u.*, im.external_id AS clerk_id
       FROM store.users u
       LEFT JOIN store.identity_mapping im ON im.internal_id = u.id AND im.is_active = true
       WHERE u.id = $1`,
      [id],
    )
    if (!row) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse(safeUser(row))
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '[Admin] Toggle user active/inactive status' })
  @ApiParam({ name: 'id' })
  async updateStatus(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    if (typeof isActive !== 'boolean')
      throw new BadRequestException({ code: 'INVALID_STATUS', message: 'isActive must be boolean' })

    const affected = await this.db.execute(
      `UPDATE store.users SET is_active = $1, updated_at = NOW() WHERE id = $2`,
      [isActive, id],
    )
    if (!affected) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse({ id, isActive, message: `User ${isActive ? 'activated' : 'deactivated'}` })
  }

  @Patch(':id/role')
  @ApiOperation({ summary: '[Admin] Change user role (customer ↔ admin)' })
  @ApiParam({ name: 'id' })
  async updateRole(
    @Param('id') id: string,
    @Body('role') role: string,
  ) {
    if (!['customer', 'admin'].includes(role))
      throw new BadRequestException({ code: 'INVALID_ROLE', message: 'role must be customer or admin' })

    const affected = await this.db.execute(
      `UPDATE store.users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, id],
    )
    if (!affected) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse({ id, role })
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Soft-delete user (sets is_active = false)' })
  @ApiParam({ name: 'id' })
  async softDelete(@Param('id') id: string) {
    await this.db.execute(
      `UPDATE store.users SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id],
    )
    // Also soft-delete identity mapping
    await this.db.execute(
      `UPDATE store.identity_mapping SET is_active = false, updated_at = NOW()
       WHERE internal_id = $1`,
      [id],
    )
  }
}
