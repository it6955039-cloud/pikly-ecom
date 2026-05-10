import { IsString, IsOptional, IsInt, Min, Max, IsArray, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'

export class AddToCartDto {
  @ApiProperty({ description: 'Product ASIN or slug', example: 'B09XYZ123' })
  @IsString()
  productId: string

  @ApiPropertyOptional({ description: 'Variant ID (size/color) — omit if product has no variants' })
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiProperty({ minimum: 1, maximum: 99, example: 1 })
  @IsInt()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity: number

  @ApiPropertyOptional({
    description: '⚠️ Guest only — ignored when Authorization header is present. ' +
      'Logged-in users never need to send this; session is derived from JWT.',
    example: 'a1b2c3d4-e5f6-...',
  })
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class UpdateCartDto {
  @ApiProperty({ example: 'B09XYZ123' })
  @IsString()
  productId: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiProperty({
    minimum: 0,
    maximum: 99,
    description: 'New quantity. Send 0 to remove the item entirely.',
    example: 3,
  })
  @IsInt()
  @Min(0)
  @Max(99)
  @Type(() => Number)
  quantity: number

  @ApiPropertyOptional({ description: '⚠️ Guest only — ignored when Authorization header is present.' })
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class RemoveFromCartDto {
  @ApiProperty({ example: 'B09XYZ123' })
  @IsString()
  productId: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiPropertyOptional({ description: '⚠️ Guest only — ignored when Authorization header is present.' })
  @IsOptional()
  @IsString()
  sessionId?: string
}

// ── NEW: Bulk remove ────────────────────────────────────────────────────────

export class BulkRemoveItemDto {
  @ApiProperty({ description: 'Product ASIN or slug', example: 'B09XYZ123' })
  @IsString()
  productId: string

  @ApiPropertyOptional({ description: 'Variant ID — only needed if product has variants' })
  @IsOptional()
  @IsString()
  variantId?: string
}

export class BulkRemoveDto {
  @ApiProperty({
    type: [BulkRemoveItemDto],
    description: 'List of items to remove (1–50). Each item identified by productId + optional variantId.',
    example: [
      { productId: 'B09XYZ123' },
      { productId: 'B08ABC456', variantId: 'B08ABC456-RED-L' },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkRemoveItemDto)
  items: BulkRemoveItemDto[]

  @ApiPropertyOptional({ description: '⚠️ Guest only — ignored when Authorization header is present.' })
  @IsOptional()
  @IsString()
  sessionId?: string
}

// ───────────────────────────────────────────────────────────────────────────

export class ApplyCouponDto {
  @ApiProperty({ example: 'SAVE10' })
  @IsString()
  code: string

  @ApiPropertyOptional({ description: '⚠️ Guest only — ignored when Authorization header is present.' })
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class MergeCartDto {
  @ApiProperty({ description: 'The guest sessionId stored in localStorage before login' })
  @IsString()
  guestSessionId: string

  // userId is set by the controller from the JWT — never accepted from the body
  userId?: string
}
