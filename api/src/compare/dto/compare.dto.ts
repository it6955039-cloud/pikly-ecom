import { IsArray, IsString, ArrayMinSize, ArrayMaxSize } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CompareDto {
  @ApiProperty({
    type: [String],
    description: 'Array of 2–4 product IDs to compare',
    example: ['prod_001', 'prod_002'],
    minItems: 2,
    maxItems: 4,
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  productIds: string[]
}
