import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsInt,
  Min,
  Max,
  IsIn,
  MaxLength,
} from 'class-validator'
import { Transform, Type } from 'class-transformer'
import { ApiPropertyOptional } from '@nestjs/swagger'

const toBool = ({ value }: { value: any }) =>
  value === 'true' || value === true || value === '1'

export class FilterProductsDto {
  // ── Full-text search ───────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Search query', example: 'wireless headphones' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string

  // ── Hierarchical category ──────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Category slug', example: 'electronics' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string

  @ApiPropertyOptional({ description: 'Subcategory slug', example: 'headphones' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subcategory?: string

  // ── Brand — comma-separated for multi-select ───────────────────────────────
  @ApiPropertyOptional({ description: 'One or more brands (comma-separated)', example: 'Sony,Bose' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  brand?: string

  // ── Price range ────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Minimum price', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number

  @ApiPropertyOptional({ description: 'Maximum price', example: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number

  // ── Rating ─────────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Minimum star rating (1–5)', example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5)
  rating?: number

  // ── Discount ───────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Minimum discount percentage (0–100)', example: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  discount?: number

  // ── Variant filters ────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Colors (comma-separated)', example: 'Black,White' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  color?: string

  @ApiPropertyOptional({ description: 'Sizes (comma-separated)', example: 'S,M,L' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  size?: string

  // ── Product condition ──────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Product condition', enum: ['New', 'Refurbished', 'Used'] })
  @IsOptional()
  @IsIn(['New', 'Refurbished', 'Used'])
  condition?: string

  // ── Warehouse ─────────────────────────────────────────────────────────────
  @ApiPropertyOptional({
    description: 'Warehouse (comma-separated)',
    example: 'WH-East-01,WH-West-01',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  warehouse?: string

  // ── New arrivals ───────────────────────────────────────────────────────────
  @ApiPropertyOptional({
    description: 'Products added in last N days',
    enum: [7, 14, 30, 90],
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 14, 30, 90])
  newArrivalDays?: number

  // ── Boolean filters ────────────────────────────────────────────────────────
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() inStock?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() isPrime?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() freeShipping?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() expressAvailable?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() onSale?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() bestSeller?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() featured?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() newArrival?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() topRated?: boolean
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() trending?: boolean

  // ── Dynamic attribute filter ───────────────────────────────────────────────
  @ApiPropertyOptional({
    description: 'Attribute filters (comma-separated key:value pairs)',
    example: 'ram:16GB,storage:512GB',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attrs?: string

  // ── Sort ───────────────────────────────────────────────────────────────────
  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['relevance', 'price_asc', 'price_desc', 'rating_desc', 'newest', 'bestselling', 'discount_desc'],
    default: 'relevance',
  })
  @IsOptional()
  @IsIn(['relevance', 'price_asc', 'price_desc', 'rating_desc', 'newest', 'bestselling', 'discount_desc'])
  sort?: string

  // ── Facets toggle ──────────────────────────────────────────────────────────
  @ApiPropertyOptional({
    description: 'Include facet counts in response (set true on first load, false on pagination)',
    default: false,
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeFacets?: boolean

  // ── Pagination ─────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ description: 'Results per page (max 100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  @ApiPropertyOptional({
    description: 'Cursor for infinite scroll / cursor pagination. Use nextCursor from previous response. Cannot combine with page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string
}
