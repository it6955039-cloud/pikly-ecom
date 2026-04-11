import { IsOptional, IsInt, IsString, IsBoolean, Min, Max } from 'class-validator'
import { Transform, Type } from 'class-transformer'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class CategoryShowcaseDto {
  @ApiPropertyOptional({
    description: 'Page number for offset pagination — use either page OR cursor, not both',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @ApiPropertyOptional({
    description: 'How many category boxes per page',
    default: 6,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 6

  @ApiPropertyOptional({
    description: 'How many products inside each category box',
    default: 4,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  productsLimit?: number = 4

  @ApiPropertyOptional({
    description: 'Filter by top-level category slug e.g. electronics, fashion',
  })
  @IsOptional()
  @IsString()
  category?: string

  @ApiPropertyOptional({
    description: 'Return only featured categories',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  onlyFeatured?: boolean = false

  @ApiPropertyOptional({
    description: 'Sort categories',
    enum: ['alphabetical', 'productCount'],
    default: 'productCount',
  })
  @IsOptional()
  @IsString()
  sort?: 'alphabetical' | 'productCount' = 'productCount'

  // ── CURSOR PAGINATION ──────────────────────────────
  @ApiPropertyOptional({
    description:
      'Cursor for cursor-based pagination — pass nextCursor from previous response. Use either cursor OR page, not both.',
    example: 'cHJvZF8wMDIx',
  })
  @IsOptional()
  @IsString()
  cursor?: string
}
