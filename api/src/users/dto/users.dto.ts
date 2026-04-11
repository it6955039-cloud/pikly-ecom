import { IsOptional, IsString, IsBoolean, MaxLength, IsNotEmpty } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) firstName?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) avatar?: string
}

// SCH-05 fix: street, city, country are now required in AddAddressDto.
// Previously every field was optional, meaning {} passed validation and an
// order could be placed with an empty shipping address.
export class AddAddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) label?: string
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) street: string
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) city: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) state?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) zip?: string
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) country: string
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean
}

// All fields optional for update — only the ones provided are changed.
export class UpdateAddressDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) label?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) street?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) city?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) state?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) zip?: string
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) country?: string
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean
}
