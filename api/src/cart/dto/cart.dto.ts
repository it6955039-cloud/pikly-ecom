import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'

export class AddToCartDto {
  @ApiProperty()
  @IsString()
  productId: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiProperty({ minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity: number

  // SEC-04: optional — authenticated users have this derived from their JWT
  // in the controller so whatever they send here is ignored. Guest users must
  // supply it via the X-Session-ID header; sending it in the body also works
  // for backward compatibility.
  @ApiPropertyOptional({ description: 'Guest session ID — ignored when authenticated' })
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class UpdateCartDto {
  @ApiProperty()
  @IsString()
  productId: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiProperty({ minimum: 0, maximum: 99, description: '0 removes the item' })
  @IsInt()
  @Min(0)
  @Max(99)
  @Type(() => Number)
  quantity: number

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class RemoveFromCartDto {
  @ApiProperty()
  @IsString()
  productId: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantId?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class ApplyCouponDto {
  @ApiProperty()
  @IsString()
  code: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionId?: string
}

export class MergeCartDto {
  @ApiProperty({ description: 'The guest sessionId to merge from' })
  @IsString()
  guestSessionId: string

  // userId is set by the controller from the JWT — never accepted from the body
  userId?: string
}
