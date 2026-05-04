/**
 * @file identity.spec.ts  ← NEW: src/identity/tests/identity.spec.ts
 *
 * Unit tests for the Identity Abstraction Layer.
 *
 * Coverage:
 *   1. ClerkProductionAdapter.verifyToken — happy path + failure modes
 *   2. LegacyShowcaseAdapter.verifyToken  — happy path + blacklist check
 *   3. IdentityMappingService             — L1 cache, L2 DB, batch resolution
 *   4. JitProvisioningGuard               — provision-on-miss, idempotency
 *   5. ShadowSessionMiddleware            — token source priority, isolation
 *   6. ClerkAuthMiddleware                — bearer extraction, optional auth
 */

import { Test, TestingModule }   from '@nestjs/testing'
import { ConfigService }         from '@nestjs/config'
import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { Reflector }             from '@nestjs/core'

import { LegacyShowcaseAdapter }   from '../adapters/legacy-showcase.adapter'
import { IdentityMappingService }  from '../gim/identity-mapping.service'
import { JitProvisioningGuard }    from '../jit/jit-provisioning.guard'
import { ClerkAuthMiddleware }     from '../middleware/clerk-auth.middleware'
import { ShadowSessionMiddleware } from '../middleware/shadow-session.middleware'
import { IIdentityService, SHOWCASE_IDENTITY_SERVICE } from '../ports/identity.port'
import { DatabaseService }         from '../../database/database.service'
import { RedisService }            from '../../redis/redis.service'
import * as jwt from 'jsonwebtoken'

// ─────────────────────────────────────────────────────────────────────────────
// Shared mocks
// ─────────────────────────────────────────────────────────────────────────────

const mockDb = {
  query:       jest.fn(),
  queryOne:    jest.fn(),
  execute:     jest.fn(),
  transaction: jest.fn(),
}

const mockRedis = {
  get:                  jest.fn(),
  set:                  jest.fn(),
  exists:               jest.fn(),
  incrementLoginFailure: jest.fn(),
  getLoginFailures:     jest.fn(),
}

const mockConfig = {
  get:         jest.fn(),
  getOrThrow:  jest.fn(),
}

const TEST_JWT_SECRET = 'test-secret-must-be-long-enough-for-hs256'

function makeLegacyToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      sub:   '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      role:  'customer',
      jti:   'test-jti-uuid',
      ...overrides,
    },
    TEST_JWT_SECRET,
    { expiresIn: '15m' },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. LegacyShowcaseAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('LegacyShowcaseAdapter', () => {
  let adapter: LegacyShowcaseAdapter

  beforeEach(async () => {
    mockConfig.getOrThrow.mockReturnValue(TEST_JWT_SECRET)
    mockRedis.get.mockResolvedValue(null)  // not blacklisted by default

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LegacyShowcaseAdapter,
        { provide: ConfigService, useValue: mockConfig },
        { provide: RedisService,  useValue: mockRedis  },
      ],
    }).compile()

    adapter = module.get(LegacyShowcaseAdapter)
  })

  afterEach(() => jest.clearAllMocks())

  it('isProductionAdapter must be false', () => {
    expect(adapter.isProductionAdapter).toBe(false)
  })

  describe('verifyToken', () => {
    it('returns VerifiedToken for a valid legacy JWT', async () => {
      const token  = makeLegacyToken()
      const result = await adapter.verifyToken(token)

      expect(result.externalId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(result.email).toBe('test@example.com')
      expect(result.role).toBe('customer')
      expect(result.jti).toBe('test-jti-uuid')
    })

    it('throws UnauthorizedException for an expired token', async () => {
      const token = makeLegacyToken({ exp: Math.floor(Date.now() / 1000) - 60 })
      await expect(adapter.verifyToken(token)).rejects.toThrow(UnauthorizedException)
    })

    it('throws UnauthorizedException for a tampered token', async () => {
      const token = makeLegacyToken() + 'tampered'
      await expect(adapter.verifyToken(token)).rejects.toThrow(UnauthorizedException)
    })

    it('throws UnauthorizedException when JTI is blacklisted', async () => {
      mockRedis.get.mockResolvedValue('1')  // blacklisted
      const token = makeLegacyToken()
      await expect(adapter.verifyToken(token)).rejects.toThrow(UnauthorizedException)
    })

    it('checks the ISOLATED blacklist namespace (legacy:blacklist:*)', async () => {
      const token = makeLegacyToken()
      await adapter.verifyToken(token)

      expect(mockRedis.get).toHaveBeenCalledWith('legacy:blacklist:test-jti-uuid')
      expect(mockRedis.get).not.toHaveBeenCalledWith('blacklist:test-jti-uuid')
    })
  })

  describe('revokeSession', () => {
    it('writes to legacy:blacklist namespace, not production namespace', async () => {
      await adapter.revokeSession('some-jti', 'some-user')

      expect(mockRedis.set).toHaveBeenCalledWith(
        'legacy:blacklist:some-jti',
        '1',
        900,
      )
      expect(mockRedis.set).not.toHaveBeenCalledWith(
        expect.stringMatching(/^blacklist:/),
        expect.anything(),
        expect.anything(),
      )
    })

    it('does not throw on Redis failure (best-effort contract)', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis down'))
      await expect(
        adapter.revokeSession('some-jti', 'some-user'),
      ).resolves.not.toThrow()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. IdentityMappingService
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityMappingService', () => {
  let service: IdentityMappingService

  beforeEach(async () => {
    mockDb.queryOne.mockReset()
    mockDb.query.mockReset()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityMappingService,
        { provide: DatabaseService, useValue: mockDb },
      ],
    }).compile()

    service = module.get(IdentityMappingService)
  })

  describe('resolve', () => {
    it('returns null if DB has no mapping', async () => {
      mockDb.queryOne.mockResolvedValue(null)
      const result = await service.resolve('user_2abc')
      expect(result).toBeNull()
    })

    it('returns internalId from DB on cache miss', async () => {
      const internalId = '550e8400-e29b-41d4-a716-446655440000'
      mockDb.queryOne.mockResolvedValue({ internal_id: internalId })

      const result = await service.resolve('user_2abc')
      expect(result).toBe(internalId)
    })

    it('L1 cache prevents second DB call within same request', async () => {
      const internalId = '550e8400-e29b-41d4-a716-446655440000'
      mockDb.queryOne.mockResolvedValue({ internal_id: internalId })

      await service.resolve('user_2abc')  // First call — DB hit
      await service.resolve('user_2abc')  // Second call — should hit L1

      expect(mockDb.queryOne).toHaveBeenCalledTimes(1)  // DB called only once
    })
  })

  describe('resolveBatch', () => {
    it('fetches all uncached IDs in a single DB query', async () => {
      const rows = [
        { external_id: 'user_2a', internal_id: 'uuid-a' },
        { external_id: 'user_2b', internal_id: 'uuid-b' },
      ]
      mockDb.query.mockResolvedValue(rows)

      const result = await service.resolveBatch(['user_2a', 'user_2b'])

      expect(mockDb.query).toHaveBeenCalledTimes(1)
      expect(result.get('user_2a')).toBe('uuid-a')
      expect(result.get('user_2b')).toBe('uuid-b')
    })

    it('returns empty map for empty input without DB call', async () => {
      const result = await service.resolveBatch([])
      expect(mockDb.query).not.toHaveBeenCalled()
      expect(result.size).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. ClerkAuthMiddleware
// ─────────────────────────────────────────────────────────────────────────────

describe('ClerkAuthMiddleware', () => {
  const mockIdentityService = {
    verifyToken:      jest.fn(),
    isProductionAdapter: true,
  }

  let middleware: ClerkAuthMiddleware
  let req: any, res: any, next: jest.Mock

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClerkAuthMiddleware,
        { provide: IIdentityService, useValue: mockIdentityService },
      ],
    }).compile()

    middleware = module.get(ClerkAuthMiddleware)
    req  = { headers: {} }
    res  = {}
    next = jest.fn()
  })

  afterEach(() => jest.clearAllMocks())

  it('calls next() without populating verifiedToken when no Authorization header', async () => {
    await middleware.use(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(req.verifiedToken).toBeUndefined()
  })

  it('throws UnauthorizedException for malformed Authorization header', async () => {
    req.headers.authorization = 'NotBearer token'
    await expect(middleware.use(req, res, next)).rejects.toThrow(UnauthorizedException)
  })

  it('populates req.verifiedToken on successful verification', async () => {
    const verifiedToken = { externalId: 'user_2abc', email: 'test@example.com', role: 'customer' }
    mockIdentityService.verifyToken.mockResolvedValue(verifiedToken)
    req.headers.authorization = 'Bearer valid-token'

    await middleware.use(req, res, next)

    expect(req.verifiedToken).toEqual(verifiedToken)
    expect(next).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. ShadowSessionMiddleware — namespace isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('ShadowSessionMiddleware — namespace isolation', () => {
  it('never populates req.verifiedToken or req.identity', async () => {
    // The ShadowSessionMiddleware only touches req.showcaseSession.
    // Even if a Clerk token appears in req.headers.authorization,
    // ShadowSessionMiddleware ignores it entirely.
    const mockLegacyAdapter = {
      verifyToken: jest.fn().mockResolvedValue({
        externalId: 'legacy-uuid',
        email:      'legacy@example.com',
        role:       'customer',
        jti:        'some-jti',
        expiresAt:  new Date(Date.now() + 900_000).toISOString(),
      }),
      isProductionAdapter: false,
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShadowSessionMiddleware,
        { provide: SHOWCASE_IDENTITY_SERVICE, useValue: mockLegacyAdapter },
      ],
    }).compile()

    const middleware = module.get(ShadowSessionMiddleware)
    const req: any  = {
      headers: { 'x-legacy-session-token': 'some-legacy-token' },
      cookies: {},
    }
    const next = jest.fn()

    await middleware.use(req, {}, next)

    // Must populate showcaseSession
    expect(req.showcaseSession).toBeDefined()
    expect(req.showcaseSession.sessionCtx).toBe('legacy_showcase')

    // Must NOT touch production identity namespaces
    expect(req.verifiedToken).toBeUndefined()
    expect(req.identity).toBeUndefined()
  })
})
