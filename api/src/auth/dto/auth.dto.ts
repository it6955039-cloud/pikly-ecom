import {
  IsString,
  IsEmail,
  MinLength,
  MaxLength,
  IsNotEmpty,
  IsOptional,
  Matches,
} from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class RegisterDto {
  @ApiProperty()
  @IsEmail()
  email: string

  @ApiProperty({ minLength: 6, maxLength: 128 })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string

  // BUG-08: @IsNotEmpty() + @MinLength(1) together reject empty strings.
  // Without @IsNotEmpty(), class-validator treats "" as a valid @IsString()
  // value, so accounts with blank names could be created. The @Matches regex
  // restricts names to alphabetic characters, spaces, hyphens, and apostrophes
  // (covering hyphenated surnames and Irish names like O'Brien) while preventing
  // angle brackets and script tags from being stored in name fields.
  @ApiProperty({ example: 'Jane' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z\s'\-]+$/, {
    message: 'First name may only contain letters, spaces, hyphens, and apostrophes',
  })
  firstName: string

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-zA-Z\s'\-]+$/, {
    message: 'Last name may only contain letters, spaces, hyphens, and apostrophes',
  })
  lastName: string
}

export class LoginDto {
  @ApiProperty()
  @IsEmail()
  email: string

  @ApiProperty({ maxLength: 128 })
  @IsString()
  @MaxLength(128)
  password: string
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string
}

export class LogoutDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  refreshToken?: string
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsEmail()
  email: string
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token: string

  @ApiProperty({ minLength: 6, maxLength: 128 })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  token: string
}

export class ChangePasswordDto {
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @MaxLength(128)
  currentPassword: string

  @ApiProperty({ minLength: 6, maxLength: 128 })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string
}

export class ResendVerificationDto {
  @ApiProperty()
  @IsEmail()
  email: string
}
