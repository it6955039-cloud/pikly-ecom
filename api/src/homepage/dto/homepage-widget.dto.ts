// src/homepage/dto/homepage-widget.dto.ts
//
// Fully-validated DTOs for the homepage widget slot system.
// Each widget type has its own config shape documented in JSDoc.
// class-validator is already a dependency of the project — no new installs.

import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsArray,
  IsObject,
  Min,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty } from '@nestjs/swagger'

// ── Widget types (mirrors the DB CHECK constraint) ────────────────────────────

export const WIDGET_TYPES = [
  'hero_banner',
  'product_carousel',
  'category_grid',
  'dept_spotlight',
  'campaign',
] as const

export type WidgetType = (typeof WIDGET_TYPES)[number]

// ── Target audience ───────────────────────────────────────────────────────────

export const WIDGET_TARGETS = ['all', 'authenticated', 'anonymous'] as const
export type WidgetTarget = (typeof WIDGET_TARGETS)[number]

// ── Per-type config shapes (documentation only — stored as raw JSONB) ─────────
//
// hero_banner:
//   { bannerPosition: 'hero' | 'secondary' | 'sidebar' | 'all' }
//
// product_carousel:
//   { strategy: 'featured' | 'bestsellers' | 'trending' | 'new_arrivals'
//               | 'on_sale' | 'top_rated' | 'by_dept',
//     dept?: string,    ← required when strategy = 'by_dept'
//     limit?: number }  ← default 12
//
// category_grid:
//   { dept?: string,           ← top-level dept filter
//     subcats?: string[],      ← specific subcategory names / slugs
//     maxPrice?: number,       ← price cap for "under $N" widgets
//     limit?: number,          ← cells to render (default 4)
//     productsPerCell?: number ← product images per cell (default 2) }
//
// dept_spotlight:
//   { dept: string, limit?: number }  ← default limit 4
//
// campaign:
//   { strategy?: 'featured' | 'bestsellers' | 'on_sale' | 'trending',
//     dept?: string,
//     limit?: number }  ← default 8

// ── Create DTO ────────────────────────────────────────────────────────────────

export class CreateWidgetDto {
  @ApiProperty({
    enum: WIDGET_TYPES,
    description: 'Rendering type — determines which resolver is invoked and expected config shape.',
  })
  @IsIn(WIDGET_TYPES)
  type: WidgetType

  @ApiProperty({ maxLength: 120, description: 'Display title (optional — front-end may override)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string

  @ApiProperty({ maxLength: 240, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  subtitle?: string

  @ApiProperty({
    maxLength: 80,
    required: false,
    description: 'Optional badge label e.g. "Limited Time"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  badge?: string

  @ApiProperty({
    description: 'Type-specific configuration object. Shape varies by widget type — see DTO docs.',
    example: { strategy: 'bestsellers', limit: 12 },
  })
  @IsObject()
  config: Record<string, any>

  @ApiProperty({ minimum: 0, maximum: 999, description: 'Display order — lower = higher on page' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  @Type(() => Number)
  position?: number

  @ApiProperty({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean

  @ApiProperty({
    enum: WIDGET_TARGETS,
    default: 'all',
    description:
      '"all" → everyone | "authenticated" → JWT required | "anonymous" → unauthenticated only',
  })
  @IsOptional()
  @IsIn(WIDGET_TARGETS)
  target?: WidgetTarget
}

// ── Update DTO ────────────────────────────────────────────────────────────────

export class UpdateWidgetDto {
  @ApiProperty({ enum: WIDGET_TYPES, required: false })
  @IsOptional()
  @IsIn(WIDGET_TYPES)
  type?: WidgetType

  @ApiProperty({ required: false, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string

  @ApiProperty({ required: false, maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  subtitle?: string

  @ApiProperty({ required: false, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  badge?: string

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  config?: Record<string, any>

  @ApiProperty({ required: false, minimum: 0, maximum: 999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  @Type(() => Number)
  position?: number

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean

  @ApiProperty({ enum: WIDGET_TARGETS, required: false })
  @IsOptional()
  @IsIn(WIDGET_TARGETS)
  target?: WidgetTarget
}

// ── Reorder DTO ───────────────────────────────────────────────────────────────
// Accepts an ordered array of widget IDs. The service assigns position = index.

export class ReorderWidgetsDto {
  @ApiProperty({
    type: [String],
    description: 'Ordered array of widget IDs. Position is assigned by array index (0 = top).',
    example: ['hw_hero', 'hw_featured', 'hw_bestsellers'],
  })
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  ids: string[]
}
