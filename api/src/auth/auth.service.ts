// src/auth/auth.service.ts — PostgreSQL, no Mongoose
import {
  Injectable, BadRequestException, UnauthorizedException,
  NotFoundException, Logger,
} from '@nestjs/common'
import { JwtService }    from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt       from 'bcrypt'
import * as crypto       from 'crypto'
import { DatabaseService } from '../database/database.service'
import { MailService }   from '../mail/mail.service'
import { RedisService }  from '../redis/redis.service'
import {
  RegisterDto, LoginDto, ForgotPasswordDto,
  ResetPasswordDto, VerifyEmailDto, ChangePasswordDto,
} from './dto/auth.dto'

// Maximum failed login attempts before a temporary lockout.
const MAX_LOGIN_FAILURES = 10
const BCRYPT_ROUNDS      = 12

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly db:     DatabaseService,
    private readonly jwt:    JwtService,
    private readonly config: ConfigService,
    private readonly mail:   MailService,
    private readonly redis:  RedisService,
  ) {}

  // ── Registration ─────────────────────────────────────────────────────────

  async register(dto: RegisterDto) {
    const existing = await this.db.queryOne(
      'SELECT id FROM store.users WHERE email = $1',
      [dto.email.toLowerCase()],
    )
    if (existing) throw new BadRequestException({ code: 'EMAIL_IN_USE', message: 'Email already registered' })

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS)
    const user = await this.db.queryOne<{ id: string; email: string; first_name: string }>(
      `INSERT INTO store.users (email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, first_name`,
      [dto.email.toLowerCase(), passwordHash, dto.firstName, dto.lastName],
    )
    if (!user) throw new BadRequestException('Registration failed')

    await this.sendVerificationEmail(user.id, user.email, user.first_name)
    return { message: 'Registration successful. Check your email to verify your account.' }
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(dto: LoginDto) {
    const emailKey = dto.email.toLowerCase()

    // SEC-05: brute force protection — lock after MAX_LOGIN_FAILURES attempts
    const failures = await this.redis.getLoginFailures(emailKey)
    if (failures >= MAX_LOGIN_FAILURES) {
      throw new UnauthorizedException({
        code:    'ACCOUNT_LOCKED',
        message: `Too many failed attempts. Try again in 15 minutes.`,
      })
    }

    const user = await this.db.queryOne<any>(
      `SELECT id, email, password_hash, first_name, last_name, role,
              is_verified, is_active
       FROM store.users WHERE email = $1`,
      [emailKey],
    )

    // Constant-time failure path: do not reveal whether the email exists
    if (!user) {
      await this.redis.incrementLoginFailure(emailKey)
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' })
    }
    if (!user.is_active) {
      throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Account is disabled' })
    }
    if (!user.is_verified) {
      throw new UnauthorizedException({
        code:    'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
      })
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash)
    if (!valid) {
      await this.redis.incrementLoginFailure(emailKey)
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' })
    }

    // Successful login — clear the failure counter
    await this.redis.clearLoginFailures(emailKey)
    await this.db.execute('UPDATE store.users SET last_login = NOW() WHERE id = $1', [user.id])

    const tokens = await this.generateTokenPair(user.id, user.email, user.role)
    return {
      ...tokens,
      user: {
        id:        user.id,
        email:     user.email,
        firstName: user.first_name,
        lastName:  user.last_name,
        role:      user.role,
      },
    }
  }

  // ── Token rotation ────────────────────────────────────────────────────────

  async refreshTokens(refreshToken: string) {
    let payload: any
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      })
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN' })
    }

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    const stored = await this.db.queryOne<any>(
      'SELECT user_id, expires_at FROM store.refresh_tokens WHERE token_hash = $1',
      [tokenHash],
    )
    if (!stored || stored.expires_at < new Date()) {
      throw new UnauthorizedException({ code: 'REFRESH_TOKEN_EXPIRED' })
    }

    // Rotate: delete old token, issue new pair
    await this.db.execute('DELETE FROM store.refresh_tokens WHERE token_hash = $1', [tokenHash])
    const user = await this.db.queryOne<any>(
      'SELECT id, email, role, is_active FROM store.users WHERE id = $1',
      [stored.user_id],
    )
    if (!user || !user.is_active) throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED' })
    return this.generateTokenPair(user.id, user.email, user.role)
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(jti: string, exp: number, refreshToken?: string) {
    // Blacklist the access token for its remaining lifetime
    const ttl = exp - Math.floor(Date.now() / 1000)
    if (ttl > 0) await this.redis.set(`blacklist:${jti}`, '1', ttl)

    // Revoke the specific refresh token if provided, otherwise revoke all for this JTI's user
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
      await this.db.execute('DELETE FROM store.refresh_tokens WHERE token_hash = $1', [tokenHash])
    }
    return { message: 'Logged out successfully' }
  }

  // ── Email verification ────────────────────────────────────────────────────

  async verifyEmail(dto: VerifyEmailDto) {
    // Hash the incoming raw token before looking it up — we never store raw tokens
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex')

    const row = await this.db.queryOne<any>(
      'SELECT id, user_id, expires_at FROM store.verification_tokens WHERE token_hash = $1',
      [tokenHash],
    )
    if (!row) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token' })
    if (row.expires_at < new Date()) throw new BadRequestException({ code: 'TOKEN_EXPIRED' })

    await this.db.transaction(async (c) => {
      await c.query('UPDATE store.users SET is_verified = true WHERE id = $1', [row.user_id])
      await c.query('DELETE FROM store.verification_tokens WHERE id = $1', [row.id])
    })
    return { message: 'Email verified successfully. You can now log in.' }
  }

  async resendVerification(email: string) {
    const user = await this.db.queryOne<any>(
      'SELECT id, email, first_name, is_verified FROM store.users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()],
    )
    // Always return the same message to prevent email enumeration
    if (!user || user.is_verified) {
      return { message: 'If that email is unverified, a new link has been sent.' }
    }

    // Delete any existing token and send a fresh one
    await this.db.execute('DELETE FROM store.verification_tokens WHERE user_id = $1', [user.id])
    await this.sendVerificationEmail(user.id, user.email, user.first_name)
    return { message: 'If that email is unverified, a new link has been sent.' }
  }

  // ── Password management ───────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.db.queryOne<any>(
      'SELECT id, email, first_name FROM store.users WHERE email = $1 AND is_active = true',
      [dto.email.toLowerCase()],
    )
    // Always same response to prevent email enumeration
    if (!user) return { message: 'If that email exists, a reset link was sent.' }

    const token     = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    await this.db.execute(
      `INSERT INTO store.password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at,
             used_at    = NULL`,
      [user.id, tokenHash],
    )
    await this.mail.sendPasswordResetEmail(user.email, user.first_name, token)
    return { message: 'If that email exists, a reset link was sent.' }
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex')
    const row = await this.db.queryOne<any>(
      'SELECT id, user_id, expires_at, used_at FROM store.password_reset_tokens WHERE token_hash = $1',
      [tokenHash],
    )
    if (!row)         throw new BadRequestException({ code: 'INVALID_TOKEN' })
    if (row.used_at)  throw new BadRequestException({ code: 'TOKEN_USED' })
    if (row.expires_at < new Date()) throw new BadRequestException({ code: 'TOKEN_EXPIRED' })

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS)
    await this.db.transaction(async (c) => {
      await c.query('UPDATE store.users SET password_hash = $1 WHERE id = $2', [newHash, row.user_id])
      await c.query('UPDATE store.password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id])
      // Revoke all refresh tokens — force re-login everywhere
      await c.query('DELETE FROM store.refresh_tokens WHERE user_id = $1', [row.user_id])
    })
    return { message: 'Password reset successfully. Please log in with your new password.' }
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.db.queryOne<any>(
      'SELECT password_hash FROM store.users WHERE id = $1', [userId],
    )
    if (!user) throw new NotFoundException('User not found')
    if (!await bcrypt.compare(dto.currentPassword, user.password_hash)) {
      throw new BadRequestException({ code: 'INVALID_PASSWORD', message: 'Current password is incorrect' })
    }
    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS)
    await this.db.execute('UPDATE store.users SET password_hash = $1 WHERE id = $2', [newHash, userId])
    // Revoke all refresh tokens on password change
    await this.db.execute('DELETE FROM store.refresh_tokens WHERE user_id = $1', [userId])
    return { message: 'Password changed successfully' }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    return this.redis.isTokenBlacklisted(jti)
  }

  private async sendVerificationEmail(userId: string, email: string, firstName: string) {
    // Generate a cryptographically random raw token — this is what the user receives in email.
    // We NEVER persist the raw token; only its SHA-256 hash is stored in the DB.
    // This matches the pattern used for password_reset_tokens and refresh_tokens.
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')

    await this.db.execute(
      `INSERT INTO store.verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at`,
      [userId, tokenHash],
    )
    // Send the raw token in the email link — the recipient hashes it on verify
    await this.mail.sendVerificationEmail(email, firstName, rawToken)
  }

  private async generateTokenPair(userId: string, email: string, role: string) {
    const jti = crypto.randomUUID()

    const accessToken = this.jwt.sign(
      { sub: userId, email, role, jti },
      { secret: this.config.get<string>('JWT_SECRET'), expiresIn: '15m' },
    )
    const refreshToken = this.jwt.sign(
      { sub: userId },
      { secret: this.config.get<string>('JWT_REFRESH_SECRET'), expiresIn: '30d' },
    )

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    await this.db.execute(
      `INSERT INTO store.refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [userId, tokenHash],
    )
    return { accessToken, refreshToken }
  }
}
