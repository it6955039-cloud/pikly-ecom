// src/admin/admin-coupons.controller.ts — PostgreSQL rewrite, no Mongoose
import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body,
  UseGuards, HttpCode, HttpStatus, NotFoundException, BadRequestException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger'
import { IsString, IsIn, IsNumber, IsBoolean, IsOptional, IsDateString,
         IsArray, Min, Max, IsInt } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { AuthGuard }       from '@nestjs/passport'
import { RolesGuard }      from '../common/guards/roles.guard'
import { Roles }           from '../common/decorators/roles.decorator'
import { DatabaseService } from '../database/database.service'
import { successResponse } from '../common/api-utils'

class CreateCouponDto {
  @ApiProperty() @IsString() code: string
  @ApiProperty({ enum: ['percentage','fixed','free_shipping'] })
  @IsIn(['percentage','fixed','free_shipping']) type: string
  @ApiProperty() @IsNumber() @Min(0) @Type(() => Number) value: number
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minOrderAmount?: number
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Type(() => Number) maxDiscount?: number
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(1) @Type(() => Number) usageLimit?: number
  @ApiProperty({ required: false }) @IsOptional() @IsArray() applicableCategories?: string[]
  @ApiProperty({ required: false }) @IsOptional() @IsArray() applicableProducts?: string[]
  @ApiProperty() @IsDateString() expiresAt: string
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() isActive?: boolean
}

class UpdateCouponDto {
  @ApiProperty({ required: false, enum: ['percentage','fixed','free_shipping'] })
  @IsOptional() @IsIn(['percentage','fixed','free_shipping']) type?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) value?: number

  @ApiProperty({ required: false })
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minOrderAmount?: number

  @ApiProperty({ required: false })
  @IsOptional() @IsNumber() @Type(() => Number) maxDiscount?: number

  @ApiProperty({ required: false })
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) usageLimit?: number

  @ApiProperty({ required: false })
  @IsOptional() @IsArray() applicableCategories?: string[]

  @ApiProperty({ required: false })
  @IsOptional() @IsArray() applicableProducts?: string[]

  @ApiProperty({ required: false })
  @IsOptional() @IsDateString() expiresAt?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean() isActive?: boolean
}

@ApiTags('Admin — Coupons')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/coupons')
export class AdminCouponsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all coupons' })
  @ApiQuery({ name: 'page',     required: false })
  @ApiQuery({ name: 'limit',    required: false })
  @ApiQuery({ name: 'isActive', required: false })
  async findAll(
    @Query('page')     page?:     string,
    @Query('limit')    limit?:    string,
    @Query('isActive') isActive?: string,
  ) {
    const p = Math.max(1, Number(page ?? 1))
    const l = Math.min(100, Math.max(1, Number(limit ?? 20)))
    const offset = (p - 1) * l

    const conditions: string[] = []
    const params: any[] = []
    let idx = 1

    if (isActive !== undefined) {
      conditions.push(`is_active = $${idx++}`)
      params.push(isActive === 'true')
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [rows, ct] = await Promise.all([
      this.db.query<any>(
        `SELECT * FROM store.coupons ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx+1}`,
        [...params, l, offset],
      ),
      this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM store.coupons ${where}`, params),
    ])

    return successResponse({
      coupons: rows,
      pagination: { total: ct?.cnt ?? 0, page: p, limit: l, totalPages: Math.ceil((ct?.cnt ?? 0) / l) },
    })
  }

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new coupon' })
  async create(@Body() body: CreateCouponDto) {
    const code = body.code.toUpperCase().trim()
    const existing = await this.db.queryOne('SELECT id FROM store.coupons WHERE code = $1', [code])
    if (existing) {
      throw new BadRequestException({ code: 'DUPLICATE_COUPON', message: `Coupon "${code}" already exists` })
    }

    const row = await this.db.queryOne<any>(
      `INSERT INTO store.coupons
         (code, type, value, min_order_amount, max_discount, usage_limit,
          applicable_categories, applicable_products, expires_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        code, body.type, body.value,
        body.minOrderAmount ?? 0, body.maxDiscount ?? null,
        body.usageLimit ?? 1000,
        body.applicableCategories ?? [], body.applicableProducts ?? [],
        new Date(body.expiresAt), body.isActive ?? true,
      ],
    )
    return successResponse(row)
  }

  @Patch(':code')
  @ApiOperation({ summary: '[Admin] Update a coupon by code' })
  @ApiParam({ name: 'code' })
  async update(@Param('code') code: string, @Body() body: UpdateCouponDto) {
    const existing = await this.db.queryOne<any>(
      'SELECT * FROM store.coupons WHERE code = $1', [code.toUpperCase()],
    )
    if (!existing) throw new NotFoundException({ code: 'COUPON_NOT_FOUND' })

    // Map DTO camelCase fields to snake_case DB columns
    const safe: Record<string, any> = {}
    if (body.type               !== undefined) safe['type']                  = body.type
    if (body.value              !== undefined) safe['value']                 = body.value
    if (body.minOrderAmount     !== undefined) safe['min_order_amount']      = body.minOrderAmount
    if (body.maxDiscount        !== undefined) safe['max_discount']          = body.maxDiscount
    if (body.usageLimit         !== undefined) safe['usage_limit']           = body.usageLimit
    if (body.applicableCategories !== undefined) safe['applicable_categories'] = body.applicableCategories
    if (body.applicableProducts !== undefined) safe['applicable_products']   = body.applicableProducts
    if (body.expiresAt          !== undefined) safe['expires_at']            = new Date(body.expiresAt)
    if (body.isActive           !== undefined) safe['is_active']             = body.isActive

    const sets: string[] = ['updated_at = NOW()']
    const vals: any[]    = []
    let   i = 1

    for (const [k, v] of Object.entries(safe)) {
      sets.push(`${k} = $${i++}`)
      vals.push(v)
    }
    vals.push(code.toUpperCase())

    const row = await this.db.queryOne<any>(
      `UPDATE store.coupons SET ${sets.join(', ')} WHERE code = $${i} RETURNING *`, vals,
    )
    return successResponse(row)
  }

  @Patch(':code/toggle')
  @ApiOperation({ summary: '[Admin] Toggle coupon active/inactive' })
  @ApiParam({ name: 'code' })
  async toggle(@Param('code') code: string) {
    const row = await this.db.queryOne<any>(
      `UPDATE store.coupons SET is_active = NOT is_active, updated_at = NOW()
       WHERE code = $1 RETURNING *`,
      [code.toUpperCase()],
    )
    if (!row) throw new NotFoundException({ code: 'COUPON_NOT_FOUND' })
    return successResponse(row)
  }

  @Delete(':code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Delete a coupon permanently' })
  @ApiParam({ name: 'code' })
  async remove(@Param('code') code: string) {
    const n = await this.db.execute('DELETE FROM store.coupons WHERE code = $1', [code.toUpperCase()])
    if (n === 0) throw new NotFoundException({ code: 'COUPON_NOT_FOUND' })
    return successResponse({ deleted: true, code: code.toUpperCase() })
  }
}
