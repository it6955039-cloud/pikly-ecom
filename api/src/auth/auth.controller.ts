import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { Throttle } from '@nestjs/throttler'
import { AuthService } from './auth.service'
import { successResponse } from '../common/api-utils'
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  LogoutDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyEmailDto,
  ChangePasswordDto,
  ResendVerificationDto,
} from './dto/auth.dto'

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: 'Register a new account (sends verification email)' })
  async register(@Body() dto: RegisterDto) {
    return successResponse(await this.authService.register(dto))
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email address using token from email link' })
  async verifyEmail(@Query('token') token: string) {
    return successResponse(await this.authService.verifyEmail({ token }))
  }

  @Post('resend-verification')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: 'Resend the verification email' })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return successResponse(await this.authService.resendVerification(dto.email))
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login — returns accessToken (15min) + refreshToken (30 days)' })
  async login(@Body() dto: LoginDto) {
    return successResponse(await this.authService.login(dto))
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token and get new access token' })
  async refresh(@Body() dto: RefreshTokenDto) {
    return successResponse(await this.authService.refreshTokens(dto.refreshToken))
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout — blacklists the access token and deletes the refresh token' })
  async logout(@Request() req: any, @Body() dto: LogoutDto) {
    const { jti, exp } = req.user
    return successResponse(await this.authService.logout(jti, exp, dto.refreshToken))
  }

  @Post('forgot-password')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return successResponse(await this.authService.forgotPassword(dto))
  }

  @Post('reset-password')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return successResponse(await this.authService.resetPassword(dto))
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password while logged in' })
  async changePassword(@Request() req: any, @Body() dto: ChangePasswordDto) {
    return successResponse(await this.authService.changePassword(req.user.userId, dto))
  }
}
