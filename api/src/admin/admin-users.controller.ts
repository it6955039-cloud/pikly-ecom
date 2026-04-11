// src/admin/admin-users.controller.ts — PostgreSQL rewrite, no Mongoose
import {
  Controller, Get, Patch, Delete, Param, Query, Body,
  UseGuards, HttpCode, HttpStatus, NotFoundException, BadRequestException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard }      from '../common/guards/roles.guard'
import { Roles }           from '../common/decorators/roles.decorator'
import { DatabaseService } from '../database/database.service'
import { successResponse } from '../common/api-utils'

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
  }
}

@ApiTags('Admin — Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all users with pagination and search' })
  @ApiQuery({ name: 'page',     required: false })
  @ApiQuery({ name: 'limit',    required: false })
  @ApiQuery({ name: 'search',   required: false })
  @ApiQuery({ name: 'role',     required: false })
  @ApiQuery({ name: 'isActive', required: false })
  async findAll(
    @Query('page')     page?:     string,
    @Query('limit')    limit?:    string,
    @Query('search')   search?:   string,
    @Query('role')     role?:     string,
    @Query('isActive') isActive?: string,
  ) {
    const p = Math.max(1, Number(page ?? 1))
    const l = Math.min(100, Math.max(1, Number(limit ?? 20)))
    const offset = (p - 1) * l

    const conditions: string[] = []
    const params: any[]        = []
    let   idx = 1

    if (role)            { conditions.push(`role = $${idx++}`);       params.push(role) }
    if (isActive !== undefined) {
      conditions.push(`is_active = $${idx++}`)
      params.push(isActive === 'true')
    }
    // Search across email, first_name, last_name using pg_trgm via ILIKE
    if (search && search.length <= 100) {
      conditions.push(`(email ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx})`)
      params.push(`%${search.replace(/[%_\\]/g, '\\$&')}%`)
      idx++
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [rows, countRow] = await Promise.all([
      this.db.query<any>(
        `SELECT id, email, first_name, last_name, role, is_active, is_verified,
                loyalty_points, last_login, created_at
         FROM store.users ${where} ORDER BY created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, l, offset],
      ),
      this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM store.users ${where}`, params,
      ),
    ])

    return successResponse({
      users: rows.map(safeUser),
      pagination: {
        total:       countRow?.cnt ?? 0,
        page:        p,
        limit:       l,
        totalPages:  Math.ceil((countRow?.cnt ?? 0) / l),
        hasNextPage: p * l < (countRow?.cnt ?? 0),
      },
    })
  }

  @Get(':id')
  @ApiOperation({ summary: '[Admin] Get single user by id' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const user = await this.db.queryOne<any>('SELECT * FROM store.users WHERE id = $1', [id])
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' })
    return successResponse(safeUser(user))
  }

  @Patch(':id/ban')
  @ApiOperation({ summary: '[Admin] Ban a user' })
  @ApiParam({ name: 'id' })
  async ban(@Param('id') id: string) {
    const user = await this.db.queryOne<any>(
      `UPDATE store.users SET is_active = false, updated_at = NOW()
       WHERE id = $1 RETURNING *`, [id],
    )
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse({ ...safeUser(user), banned: true })
  }

  @Patch(':id/unban')
  @ApiOperation({ summary: '[Admin] Unban a user' })
  @ApiParam({ name: 'id' })
  async unban(@Param('id') id: string) {
    const user = await this.db.queryOne<any>(
      `UPDATE store.users SET is_active = true, updated_at = NOW()
       WHERE id = $1 RETURNING *`, [id],
    )
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse({ ...safeUser(user), banned: false })
  }

  @Patch(':id/role')
  @ApiOperation({ summary: '[Admin] Change user role (customer | admin)' })
  @ApiParam({ name: 'id' })
  async changeRole(@Param('id') id: string, @Body() body: { role: string }) {
    if (!['customer', 'admin'].includes(body.role)) {
      throw new BadRequestException({ code: 'INVALID_ROLE', message: 'Role must be "customer" or "admin"' })
    }
    const user = await this.db.queryOne<any>(
      `UPDATE store.users SET role = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`, [body.role, id],
    )
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse(safeUser(user))
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Permanently delete a user account' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    const n = await this.db.execute('DELETE FROM store.users WHERE id = $1', [id])
    if (n === 0) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return successResponse({ deleted: true, id })
  }
}
