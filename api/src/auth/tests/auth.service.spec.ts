// src/auth/tests/auth.service.spec.ts — PostgreSQL-based tests, no Mongoose
import { Test, TestingModule }   from '@nestjs/testing'
import { JwtService }            from '@nestjs/jwt'
import { ConfigService }         from '@nestjs/config'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import { AuthService }           from '../auth.service'
import { DatabaseService }       from '../../database/database.service'
import { MailService }           from '../../mail/mail.service'
import { RedisService }          from '../../redis/redis.service'
import * as bcrypt               from 'bcrypt'

// ── Minimal mock factories ────────────────────────────────────────────────────

function makeDatabaseService() {
  return {
    query:    jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute:  jest.fn().mockResolvedValue(1),
    transaction: jest.fn().mockImplementation(async (fn: any) => fn({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    })),
  }
}

function makeRedisService() {
  return {
    get:                  jest.fn().mockResolvedValue(null),
    set:                  jest.fn().mockResolvedValue(undefined),
    del:                  jest.fn().mockResolvedValue(undefined),
    isTokenBlacklisted:   jest.fn().mockResolvedValue(false),
    incrementLoginFailure:jest.fn().mockResolvedValue(1),
    getLoginFailures:     jest.fn().mockResolvedValue(0),
    clearLoginFailures:   jest.fn().mockResolvedValue(undefined),
  }
}

function makeMailService() {
  return {
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  }
}

function makeJwtService() {
  return {
    sign:   jest.fn().mockReturnValue('mock.jwt.token'),
    verify: jest.fn().mockReturnValue({ sub: 'user-uuid-1', email: 'test@test.com' }),
  }
}

function makeConfigService() {
  return {
    get: jest.fn().mockReturnValue('test-secret'),
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService
  let db:      ReturnType<typeof makeDatabaseService>
  let redis:   ReturnType<typeof makeRedisService>
  let mail:    ReturnType<typeof makeMailService>
  let jwt:     ReturnType<typeof makeJwtService>

  beforeEach(async () => {
    db    = makeDatabaseService()
    redis = makeRedisService()
    mail  = makeMailService()
    jwt   = makeJwtService()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DatabaseService, useValue: db },
        { provide: RedisService,    useValue: redis },
        { provide: MailService,     useValue: mail },
        { provide: JwtService,      useValue: jwt },
        { provide: ConfigService,   useValue: makeConfigService() },
      ],
    }).compile()

    service = module.get<AuthService>(AuthService)
  })

  // ── register ───────────────────────────────────────────────────────────────

  describe('register', () => {
    it('throws EMAIL_IN_USE if email already exists', async () => {
      db.queryOne.mockResolvedValueOnce({ id: 'existing-id' })
      await expect(
        service.register({ email: 'dupe@test.com', password: 'Pass123!', firstName: 'A', lastName: 'B' }),
      ).rejects.toThrow(BadRequestException)
    })

    it('creates user and sends verification email', async () => {
      db.queryOne
        .mockResolvedValueOnce(null)                              // email check
        .mockResolvedValueOnce({ id: 'uid1', email: 'a@b.com', first_name: 'Alice' }) // INSERT RETURNING
        .mockResolvedValueOnce(null)                              // INSERT verification token

      const result = await service.register({
        email: 'alice@example.com', password: 'Secure123!',
        firstName: 'Alice', lastName: 'Smith',
      })

      expect(mail.sendVerificationEmail).toHaveBeenCalled()
      expect(result.message).toMatch(/verification/i)
    })
  })

  // ── login ──────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('throws INVALID_CREDENTIALS for unknown email', async () => {
      redis.getLoginFailures.mockResolvedValueOnce(0)
      db.queryOne.mockResolvedValueOnce(null) // user not found

      await expect(
        service.login({ email: 'nobody@test.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException)
      expect(redis.incrementLoginFailure).toHaveBeenCalled()
    })

    it('throws EMAIL_NOT_VERIFIED if user is unverified', async () => {
      redis.getLoginFailures.mockResolvedValueOnce(0)
      db.queryOne.mockResolvedValueOnce({
        id: 'uid1', email: 'a@b.com', password_hash: await bcrypt.hash('pass', 4),
        role: 'customer', is_verified: false, is_active: true,
      })

      await expect(
        service.login({ email: 'a@b.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('throws ACCOUNT_LOCKED after too many failures', async () => {
      redis.getLoginFailures.mockResolvedValueOnce(10)

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('returns tokens on successful login', async () => {
      redis.getLoginFailures.mockResolvedValueOnce(0)
      const hash = await bcrypt.hash('correct', 4)
      db.queryOne
        .mockResolvedValueOnce({
          id: 'uid1', email: 'a@b.com', password_hash: hash,
          role: 'customer', is_verified: true, is_active: true,
          first_name: 'Alice', last_name: 'Smith',
        })
        .mockResolvedValueOnce(null) // execute last_login
        .mockResolvedValueOnce(null) // INSERT refresh_token

      const result = await service.login({ email: 'a@b.com', password: 'correct' })
      expect(result).toHaveProperty('accessToken')
      expect(result).toHaveProperty('refreshToken')
      expect(redis.clearLoginFailures).toHaveBeenCalled()
    })
  })

  // ── verifyEmail ────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('throws INVALID_TOKEN for unknown token', async () => {
      db.queryOne.mockResolvedValueOnce(null)
      await expect(service.verifyEmail({ token: 'bad-token' })).rejects.toThrow(BadRequestException)
    })

    it('throws TOKEN_EXPIRED for expired token', async () => {
      db.queryOne.mockResolvedValueOnce({
        id: 'tid1', user_id: 'uid1',
        expires_at: new Date(Date.now() - 1000),
      })
      await expect(service.verifyEmail({ token: 'expired' })).rejects.toThrow(BadRequestException)
    })
  })

  // ── logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('blacklists token in Redis', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 900
      await service.logout('jti-abc', futureExp, undefined)
      expect(redis.set).toHaveBeenCalledWith('blacklist:jti-abc', '1', expect.any(Number))
    })
  })

  // ── forgotPassword ─────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('always returns the same message regardless of email existence', async () => {
      db.queryOne.mockResolvedValueOnce(null) // user not found
      const r1 = await service.forgotPassword({ email: 'unknown@test.com' })
      expect(r1.message).toContain('sent')

      db.queryOne.mockResolvedValueOnce({ id: 'uid1', email: 'known@test.com', first_name: 'Bob' })
      db.execute.mockResolvedValueOnce(1)
      const r2 = await service.forgotPassword({ email: 'known@test.com' })
      expect(r2.message).toContain('sent')
    })
  })
})
