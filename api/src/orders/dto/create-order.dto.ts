import { IsString, IsOptional, IsIn, IsObject, ValidateNested, IsNotEmpty, MaxLength } from 'class-validator'
import { Type } from 'class-transformer'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class ShippingAddressDto {
  @ApiPropertyOptional({ example: 'Home' })
  @IsOptional() @IsString() @MaxLength(50)
  label?: string

  @ApiProperty({ example: '123 Main St' })
  @IsString() @IsNotEmpty() @MaxLength(200)
  street: string

  @ApiProperty({ example: 'New York' })
  @IsString() @IsNotEmpty() @MaxLength(100)
  city: string

  @ApiPropertyOptional({ example: 'NY' })
  @IsOptional() @IsString() @MaxLength(100)
  state?: string

  @ApiPropertyOptional({ example: '10001' })
  @IsOptional() @IsString() @MaxLength(20)
  zip?: string

  @ApiProperty({ example: 'US' })
  @IsString() @IsNotEmpty() @MaxLength(100)
  country: string
}

export class CreateOrderDto {
  @ApiProperty({ type: ShippingAddressDto })
  @IsObject() @ValidateNested() @Type(() => ShippingAddressDto)
  shippingAddress: ShippingAddressDto

  @ApiProperty({ enum: ['card', 'cod', 'wallet'] })
  @IsIn(['card', 'cod', 'wallet'])
  paymentMethod: string

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  notes?: string

  @ApiPropertyOptional({ description: 'Client-generated UUID to prevent duplicate orders on retry (24-hour window)' })
  @IsOptional() @IsString() @MaxLength(128)
  idempotencyKey?: string
}
