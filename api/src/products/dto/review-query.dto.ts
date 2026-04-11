import { IsOptional, IsNumber, IsString, IsBoolean } from 'class-validator'
import { Transform, Type } from 'class-transformer'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class ReviewQueryDto {
  @ApiPropertyOptional({
    description: 'Page number — use either page OR cursor, not both',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number

  @ApiPropertyOptional({ description: 'Reviews per page (default: 10)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number

  @ApiPropertyOptional({
    description: 'Sort: newest | helpful | rating_high | rating_low',
  })
  @IsOptional()
  @IsString()
  sort?: string

  @ApiPropertyOptional({ description: 'Filter by star rating (1-5)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rating?: number

  @ApiPropertyOptional({ description: 'Only verified purchase reviews' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  verified?: boolean

  @ApiPropertyOptional({
    description:
      'Cursor for cursor-based pagination — pass nextCursor from previous response. Use either cursor OR page, not both.',
    example: 'cHJvZF8wMDIx',
  })
  @IsOptional()
  @IsString()
  cursor?: string
}
