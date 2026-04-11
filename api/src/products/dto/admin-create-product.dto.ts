import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

class PricingDto {
  @ApiProperty({ example: 999.99 })
  @IsNumber()
  @Min(0)
  current!: number

  @ApiPropertyOptional({ example: 1299.99 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  original?: number

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountPercent?: number
}

class InventoryDto {
  @ApiProperty({ example: 100 })
  @IsNumber()
  @Min(0)
  stock!: number

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sold?: number
}

class MediaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  thumb?: string

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  gallery?: string[]
}

export class AdminCreateProductDto {
  @ApiProperty({ example: 'prod_123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id!: string

  @ApiProperty({ example: 'awesome-smartphone-x' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  slug!: string

  @ApiProperty({ example: 'Awesome Smartphone X' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subcategory?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subSubcategory?: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]

  @ApiProperty({ type: PricingDto })
  @ValidateNested()
  @Type(() => PricingDto)
  pricing!: PricingDto

  @ApiProperty({ type: InventoryDto })
  @ValidateNested()
  @Type(() => InventoryDto)
  inventory!: InventoryDto

  @ApiPropertyOptional({ type: MediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MediaDto)
  media?: MediaDto

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  featured?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  bestSeller?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  newArrival?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trending?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  topRated?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  onSale?: boolean

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}
