/**
 * @file admin/admin-categories.controller.ts
 *
 * Fixes:
 *   BUG-CAT-LIST   — findAll() was reading this.categoriesService.categories
 *                    which is the in-memory array loaded with WHERE is_active=true.
 *                    Inactive categories were INVISIBLE to admins.
 *                    Fix: query DB directly, return active + inactive both.
 *
 *   BUG-CAT-TOGGLE — toggle() read from the same stale in-memory array.
 *                    Toggling an already-inactive category back to active always
 *                    threw CATEGORY_NOT_FOUND because inactive rows are absent
 *                    from the array.
 *                    Fix: query DB directly for current is_active state.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common'
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiProperty,
} from '@nestjs/swagger'
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'
import { RequireRoleGuard } from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole } from '../identity/guards/identity.guards'
import { CategoriesService } from '../categories/categories.service'
import { DatabaseService } from '../database/database.service'
import { successResponse } from '../common/api-utils'

// ── DTOs ──────────────────────────────────────────────────────────────────────

class CreateCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string

  @ApiProperty({
    description: 'URL-safe slug (auto-derived from name if omitted)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string

  @ApiProperty({ required: false, description: 'Parent category id for nested categories' })
  @IsOptional()
  @IsString()
  parentId?: string

  @ApiProperty({ required: false, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  level?: number

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  @ApiProperty({ required: false, minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number
}

class UpdateCategoryDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  is_featured?: boolean

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean

  @ApiProperty({ required: false, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sort_order?: number

  @ApiProperty({ required: false, description: 'Category image URL' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  image?: string

  @ApiProperty({ required: false, description: 'Facet configuration array' })
  @IsOptional()
  @IsArray()
  facets?: any[]
}

@ApiTags('Admin — Categories')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly db: DatabaseService,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '[Admin] List all categories — includes inactive' })
  @ApiQuery({ name: 'isActive', required: false, description: 'true | false — omit for all' })
  async findAll(@Query('isActive') isActive?: string) {
    // FIX: Query DB directly instead of reading in-memory categories[] array.
    // The array only contains active categories (WHERE is_active=true in loadCategories).
    // Admin must see inactive categories too.
    const conditions: string[] = []
    const params: any[] = []

    if (isActive !== undefined) {
      conditions.push(`is_active = $1`)
      params.push(isActive === 'true')
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = await this.db.query<any>(
      `SELECT * FROM store.categories ${where} ORDER BY level ASC, sort_order ASC`,
      params,
    )
    return successResponse(rows)
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new category' })
  async create(@Body() body: CreateCategoryDto) {
    return successResponse(await this.categoriesService.adminCreate(body))
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update category by id' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() body: UpdateCategoryDto) {
    return successResponse(await this.categoriesService.adminUpdate(id, body))
  }

  // ── Toggle active / inactive ───────────────────────────────────────────────

  @Patch(':id/toggle')
  @ApiOperation({
    summary: '[Admin] Toggle category active/inactive',
    description: 'Reads current is_active from DB directly — not from in-memory array.',
  })
  @ApiParam({ name: 'id' })
  async toggle(@Param('id') id: string) {
    // FIX: Query DB directly.
    // The in-memory array only has active categories — toggling an inactive
    // category back to active always threw CATEGORY_NOT_FOUND from the array.
    const row = await this.db.queryOne<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM store.categories WHERE id = $1`,
      [id],
    )

    if (!row) {
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: `Category "${id}" not found`,
      })
    }

    const updated = await this.categoriesService.adminUpdate(id, { is_active: !row.is_active })
    return successResponse({
      ...updated,
      is_active: !row.is_active, // Return new state so frontend doesn't need a refetch
    })
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Delete a category permanently' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.categoriesService.adminDelete(id))
  }
}
