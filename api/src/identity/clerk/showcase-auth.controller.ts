/**
 * @file showcase-auth.controller.ts
 * @layer Infrastructure / Showcase
 *
 * ShowcaseAuthController — the legacy authentication surface, preserved intact
 * for interactive demonstration of the "before" state of the identity system.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DORMANT SHADOW — SHOWCASE ONLY                                         ║
 * ║                                                                         ║
 * ║  All routes are prefixed /showcase/auth/* and are served exclusively    ║
 * ║  under ShadowSessionMiddleware. They NEVER participate in the           ║
 * ║  production authentication lifecycle.                                   ║
 * ║                                                                         ║
 * ║  What this demonstrates:                                                ║
 * ║    • The original bcrypt + HS256 JWT login flow                         ║
 * ║    • Brute-force protection via isolated Redis namespace                 ║
 * ║    • Token refresh and logout using the legacy token engine              ║
 * ║    • The session lifecycle that has been replaced by Clerk              ║
 * ║                                                                         ║
 * ║  Tokens issued here: signed with JWT_SECRET (same key, isolated ns)    ║
 * ║  Cookie set here:    legacy_session (not the production session cookie) ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { ConfigService } from '@nestjs/config'
import { Request, Response } from 'express'
import * as bcrypt from 'bcrypt'
import * as jwt from 'jsonwebtoken'
import * as crypto from 'crypto'

import { DatabaseService }        from '../../database/database.service'
import { RedisService }           from '../../redis/redis.service'
import { ShowcaseAuthGuard }      from '../guards/identity.guards'
import { ShowcaseUser }           from '../decorators/identity.decorators'
import { ShowcaseSession, LEGACY_SESSION_COOKIE } from '../middleware/shadow-session.middleware'
import { LegacyShowcaseAdapter }  from '../adapters/legacy-showcase.adapter'
import { successResponse }        from '../../common/api-utils'

// ── DTOs ──────────────────────────────────────────────────────────────────────

class ShowcaseLoginDto {
  @ApiProperty({ example: 'demo@pikly.com' })
  @IsEmail()
  email: string

  @ApiProperty({ example: 'demo-password-123' })
  @IsString()
  @MaxLength(128)
  password: string
}

class ShowcaseRegisterDto {
  @ApiProperty({ example: 'showcase@pikly.com' })
  @IsEmail()
  email: string

  @ApiProperty({ minLength: 6, maxLength: 128 })
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string

  @ApiProperty({ example: 'Demo' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string

  @ApiProperty({ example: 'User' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string
}

// Cookie config — HTTPOnly, SameSite=Strict, short TTL (15 min = access token lifetime)
const COOKIE_OPTIONS = {
  httpOnly:  true,
  secure:    process.env['NODE_ENV'] === 'production',
  sameSite:  'strict' as const,
  maxAge:    15 * 60 * 1000,   // 15 minutes in ms
  path:      '/showcase',      // Scoped to showcase routes ONLY
}

const LEGACY_BLACKLIST_NS  = 'legacy:blacklist'
const LEGACY_FAILURE_NS    = 'legacy:login_failure'
const MAX_LOGIN_FAILURES   = 10
const BCRYPT_ROUNDS        = 12
const ACCESS_TOKEN_TTL     = '15m'

@ApiTags('Showcase / Legacy Auth')
@Controller('showcase/auth')
export class ShowcaseAuthController {
  private readonly logger = new Logger(ShowcaseAuthController.name)

  constructor(
    private readonly db:             DatabaseService,
    private readonly redis:          RedisService,
    private readonly config:         ConfigService,
    private readonly legacyAdapter:  LegacyShowcaseAdapter,
  ) {}

  // ── Login ──────────────────────────────────────────────────────────────────

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Showcase] Login with legacy bcrypt/JWT — demonstrates original auth flow',
    description:
      'Issues a legacy HS256 JWT stored in the `legacy_session` cookie (scoped to /showcase). ' +
      'This token is only accepted by showcase routes — production endpoints reject it.',
  })
  async login(
    @Body() dto: ShowcaseLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const emailKey = dto.email.toLowerCase()

    // Brute-force check — ISOLATED namespace
    const failures = await this.redis.getLoginFailures(emailKey)
    if (failures >= MAX_LOGIN_FAILURES) {
      throw new UnauthorizedException({
        code:    'SHOWCASE_ACCOUNT_LOCKED',
        message: 'Too many showcase login attempts. Isolated from production rate limits.',
      })
    }

    // Only allow login for LEGACY auth_provider users in showcase
    const user = await this.db.queryOne<any>(
      `SELECT id, email, password_hash, first_name, last_name, role,
              is_verified, is_active, auth_provider
       FROM store.users
       WHERE email = $1`,
      [emailKey],
    )

    if (!user || user.auth_provider !== 'legacy') {
      await this.redis.incrementLoginFailure(emailKey)
      throw new UnauthorizedException({
        code:    'SHOWCASE_INVALID_CREDENTIALS',
        message: 'Invalid credentials, or this account uses Clerk authentication.',
      })
    }

    if (!user.is_active) {
      throw new UnauthorizedException({ code: 'SHOWCASE_ACCOUNT_DISABLED' })
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash)
    if (!valid) {
      await this.redis.incrementLoginFailure(emailKey)
      throw new UnauthorizedException({ code: 'SHOWCASE_INVALID_CREDENTIALS' })
    }

    await this.redis.clearLoginFailures(emailKey)

    // Issue LEGACY HS256 JWT — same shape as the original system
    const jti         = crypto.randomUUID()
    const secret      = this.config.getOrThrow<string>('JWT_SECRET')
    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, jti },
      secret,
      { expiresIn: ACCESS_TOKEN_TTL },
    )

    // Set ISOLATED cookie — path=/showcase ensures it NEVER reaches production routes
    res.cookie(LEGACY_SESSION_COOKIE, accessToken, COOKIE_OPTIONS)

    this.logger.log(`[Showcase] Login: ${emailKey} (${user.id})`)

    return successResponse({
      message:    'Showcase login successful. Token set in legacy_session cookie.',
      sessionCtx: 'legacy_showcase',
      user: {
        id:        user.id,
        email:     user.email,
        firstName: user.first_name,
        lastName:  user.last_name,
        role:      user.role,
      },
      note: 'This token is ONLY accepted on /showcase/* routes. Production endpoints ignore it.',
    })
  }

  // ── Register (Showcase only) ───────────────────────────────────────────────

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '[Showcase] Register with legacy bcrypt — demonstrates original registration',
    description:
      'Creates a user with auth_provider=legacy. This user can ONLY authenticate via ' +
      'the legacy showcase adapter. Distinct from Clerk-managed users.',
  })
  async register(@Body() dto: ShowcaseRegisterDto) {
    const emailKey = dto.email.toLowerCase()

    const existing = await this.db.queryOne(
      'SELECT id FROM store.users WHERE email = $1',
      [emailKey],
    )
    if (existing) {
      throw new BadRequestException({
        code:    'SHOWCASE_EMAIL_IN_USE',
        message: 'Email already registered (legacy or Clerk)',
      })
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS)

    const user = await this.db.queryOne<{ id: string; email: string }>(
      `INSERT INTO store.users
         (email, password_hash, first_name, last_name, role,
          is_verified, is_active, auth_provider)
       VALUES ($1, $2, $3, $4, 'customer', true, true, 'legacy')
       RETURNING id, email`,
      [emailKey, passwordHash, dto.firstName, dto.lastName],
    )

    if (!user) throw new BadRequestException('Showcase registration failed')

    this.logger.log(`[Showcase] Registered legacy user: ${emailKey} (${user.id})`)

    return successResponse({
      message:    'Showcase registration successful. Use /showcase/auth/login to authenticate.',
      sessionCtx: 'legacy_showcase',
      userId:     user.id,
      note:       'This account uses legacy bcrypt auth and is ONLY usable on /showcase/* routes.',
    })
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  @Post('logout')
  @UseGuards(ShowcaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Showcase] Logout — blacklists the legacy JTI in the isolated Redis namespace',
  })
  async logout(
    @ShowcaseUser() session: ShowcaseSession,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Blacklist the JTI in the ISOLATED namespace
    if (session.jti) {
      await this.legacyAdapter.revokeSession(session.jti, session.legacyUserId)
    }

    // Clear the isolated cookie
    res.clearCookie(LEGACY_SESSION_COOKIE, { path: '/showcase' })

    this.logger.log(`[Showcase] Logout: ${session.email} (${session.legacyUserId})`)

    return successResponse({
      message:    'Showcase session terminated.',
      sessionCtx: 'legacy_showcase',
      note:       'JTI blacklisted in legacy:blacklist namespace — does not affect production.',
    })
  }

  // ── Token introspect (demo endpoint) ──────────────────────────────────────

  @Post('introspect')
  @UseGuards(ShowcaseAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Showcase] Introspect current legacy session — for demonstration',
  })
  introspect(@ShowcaseUser() session: ShowcaseSession) {
    return successResponse({
      sessionCtx:    session.sessionCtx,
      legacyUserId:  session.legacyUserId,
      email:         session.email,
      role:          session.role,
      expiresAt:     session.expiresAt,
      isBlacklisted: false,   // Already checked by ShowcaseAuthGuard
      note: [
        'This session was verified by LegacyShowcaseAdapter (HS256/JWT_SECRET).',
        'Production adapter (ClerkProductionAdapter) had ZERO involvement.',
        'Redis namespace used: legacy:blacklist:{jti}',
        'Production namespace: blacklist:{jti} — completely separate.',
      ],
    })
  }
}
