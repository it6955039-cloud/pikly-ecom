/**
 * @file legacy-showcase.adapter.ts
 * @layer Infrastructure / Adapter (Dormant Secondary)
 *
 * LegacyShowcaseAdapter — implements IIdentityService using the existing
 * custom JWT engine (bcrypt + passport-jwt + Redis blacklist).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DORMANT SHADOW IMPLEMENTATION                                          ║
 * ║                                                                         ║
 * ║  This adapter is NOT wired into the production security context.        ║
 * ║  It is ONLY reachable via routes prefixed with /showcase/* and only     ║
 * ║  when the ShadowSessionMiddleware resolves a legacy session cookie.      ║
 * ║                                                                         ║
 * ║  The adapter is preserved in its entirety so the legacy auth flow can   ║
 * ║  be demonstrated interactively without touching Clerk.                  ║
 * ║                                                                         ║
 * ║  isProductionAdapter = false ensures the middleware chain NEVER routes  ║
 * ║  production traffic here, even if injected into the same container.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Session isolation:
 *   - Reads from header:  X-Legacy-Session-Token (not Authorization)
 *   - Cookie namespace:   legacy_session (not the production session cookie)
 *   - Redis namespace:    legacy:blacklist:{jti}  (not blacklist:{jti})
 *
 * This namespace separation guarantees zero bleed between contexts even
 * if both adapters process the same request.
 */

import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as jwt from 'jsonwebtoken'
import {
  IIdentityService,
  ProvisionPayload,
  VerifiedToken,
} from '../ports/identity.port'
import { LegacyJwtPayloadSchema } from '../schemas/identity.schemas'
import { RedisService } from '../../redis/redis.service'

// ── Showcase-specific Redis namespace ───────────────────────────────────────

const LEGACY_BLACKLIST_NS = 'legacy:blacklist'
const LEGACY_FAILURE_NS   = 'legacy:login_failure'

@Injectable()
export class LegacyShowcaseAdapter extends IIdentityService {
  /**
   * CRITICAL: this must remain false.
   * The ClerkAuthMiddleware checks this to decide if the adapter owns
   * production traffic. Having two adapters with isProductionAdapter=true
   * is a programming error caught at module init time (see identity.module.ts).
   */
  readonly isProductionAdapter = false

  private readonly logger = new Logger(LegacyShowcaseAdapter.name)

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    super()
  }

  // ── IIdentityService implementation ─────────────────────────────────────

  /**
   * Verify a legacy JWT using the existing HS256 secret.
   * Checks the ISOLATED Redis namespace — never touches production blacklist.
   */
  async verifyToken(rawToken: string): Promise<VerifiedToken> {
    const secret = this.config.getOrThrow<string>('JWT_SECRET')

    let decoded: unknown
    try {
      decoded = jwt.verify(rawToken, secret)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.debug(`[Showcase] Legacy JWT invalid: ${msg}`)
      throw new UnauthorizedException({
        code:    'LEGACY_TOKEN_INVALID',
        message: 'Legacy showcase token failed verification',
      })
    }

    const parsed = LegacyJwtPayloadSchema.safeParse(decoded)
    if (!parsed.success) {
      throw new UnauthorizedException({
        code:    'LEGACY_TOKEN_MALFORMED',
        message: 'Token shape does not match legacy schema',
      })
    }

    const claims = parsed.data

    // Check ISOLATED blacklist namespace — not the production namespace
    const isBlacklisted = await this.redis.get(
      `${LEGACY_BLACKLIST_NS}:${claims.jti}`,
    )
    if (isBlacklisted) {
      throw new UnauthorizedException({
        code:    'LEGACY_TOKEN_REVOKED',
        message: 'Legacy session has been revoked',
      })
    }

    return {
      externalId: claims.sub,   // legacy: sub IS the internal UUID
      email:      claims.email,
      role:       claims.role,
      jti:        claims.jti,
      expiresAt:  new Date(claims.exp * 1000).toISOString(),
    }
  }

  /**
   * No-op for showcase: the legacy system never provisions new users
   * via this path. Existing users are in the DB already.
   * Returns the externalId as the internalId (they were the same in
   * the legacy system — UUIDs served as both).
   */
  async provisionUser(payload: ProvisionPayload): Promise<string> {
    this.logger.debug(
      `[Showcase] provisionUser called — legacy adapter is read-only. ` +
      `Returning externalId as internalId for: ${payload.email}`,
    )
    // Legacy: externalId IS the UUID primary key
    return payload.externalId
  }

  /**
   * Revoke a legacy session by writing to the ISOLATED Redis namespace.
   * TTL matches the original JWT expiry (15 minutes max).
   */
  async revokeSession(jti: string, _externalId: string): Promise<void> {
    try {
      await this.redis.set(
        `${LEGACY_BLACKLIST_NS}:${jti}`,
        '1',
        900, // 15-minute TTL matches JWT_EXPIRY
      )
    } catch (err) {
      // Best-effort per contract
      this.logger.warn(`[Showcase] Failed to revoke legacy session ${jti}: ${String(err)}`)
    }
  }

  // ── Showcase-only helpers (not on the port — not accessible from domain) ──

  async incrementLoginFailure(email: string): Promise<void> {
    // New RedisService.incrementLoginFailure() takes email directly and
    // prefixes with 'login_fail:' internally. We pass the email as-is.
    // The legacy:login_failure namespace is no longer used for the counter;
    // only the blacklist uses the isolated legacy:blacklist: namespace via raw get/set.
    await this.redis.incrementLoginFailure(email)
  }

  async getLoginFailures(email: string): Promise<number> {
    return this.redis.getLoginFailures(email)
  }
}
