/**
 * @file shadow-session.middleware.ts
 * @layer Infrastructure / Middleware
 *
 * ShadowSessionMiddleware — the ISOLATED resolver for Legacy Showcase routes.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SECURITY BOUNDARY — READ CAREFULLY                                     ║
 * ║                                                                         ║
 * ║  This middleware operates in a COMPLETELY SEPARATE namespace from        ║
 * ║  ClerkAuthMiddleware. They CANNOT both run on the same request.         ║
 * ║  IdentityModule.configure() ensures:                                    ║
 * ║    • ClerkAuthMiddleware → all routes EXCEPT /showcase/*                ║
 * ║    • ShadowSessionMiddleware → ONLY /showcase/* routes                  ║
 * ║                                                                         ║
 * ║  The legacy session NEVER touches:                                      ║
 * ║    • req.verifiedToken (Clerk namespace)                                ║
 * ║    • req.identity (resolved production identity)                        ║
 * ║    • The production Redis blacklist namespace                            ║
 * ║                                                                         ║
 * ║  It populates:                                                          ║
 * ║    • req.showcaseSession — isolated session object                       ║
 * ║  Controllers on /showcase/* read from req.showcaseSession ONLY.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Token sources (checked in order, first match wins):
 *   1. HTTP-only cookie: legacy_session
 *   2. Header: X-Legacy-Session-Token
 *
 * This dual-source allows both browser-based and API client showcase usage.
 */

import {
  Injectable,
  Logger,
  NestMiddleware,
} from '@nestjs/common'
import { Request, Response, NextFunction } from 'express'
import {
  IIdentityService,
  SHOWCASE_IDENTITY_SERVICE,
  VerifiedToken,
} from '../ports/identity.port'
import { Inject } from '@nestjs/common'

/**
 * Shape of the showcase session attached to the request.
 * Deliberately different from ResolvedIdentity to prevent
 * accidental cross-context usage in domain code.
 */
export interface ShowcaseSession {
  /** The legacy internal UUID (was both internal and external ID in old system) */
  legacyUserId:  string
  email:         string
  role:          'customer' | 'admin'
  jti:           string
  expiresAt:     string
  /** Always 'legacy_showcase' — guards use this to prevent cross-context access */
  sessionCtx:    'legacy_showcase'
}

// Augment Express Request for the showcase namespace
declare module 'express' {
  interface Request {
    showcaseSession?: ShowcaseSession
  }
}

/** Cookie name for the legacy session — isolated from production cookies */
export const LEGACY_SESSION_COOKIE = 'legacy_session'

/** Header name for API-client showcase access */
export const LEGACY_SESSION_HEADER = 'x-legacy-session-token'

@Injectable()
export class ShadowSessionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ShadowSessionMiddleware.name)

  constructor(
    @Inject(SHOWCASE_IDENTITY_SERVICE)
    private readonly legacyAdapter: IIdentityService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // ── SAFETY ASSERTION ────────────────────────────────────────────────
    // If ClerkAuthMiddleware ran on this request, something is wrong with
    // the route config. Fail loudly in non-production environments.
    if (req.verifiedToken || req.identity) {
      this.logger.error(
        '[ShadowSession] SECURITY VIOLATION: Clerk identity found on showcase route. ' +
        'Check IdentityModule.configure() route exclusions.',
      )
      if (process.env['NODE_ENV'] !== 'production') {
        throw new Error('Shadow session middleware found production identity on showcase route')
      }
      // In production: log the anomaly but allow the request to continue
      // without a showcase session. The route's guard will reject if auth is needed.
      return next()
    }

    // ── Token extraction (cookie → header precedence) ────────────────────
    const token: string | undefined =
      (req.cookies as Record<string, string> | undefined)?.[LEGACY_SESSION_COOKIE] ??
      (req.headers[LEGACY_SESSION_HEADER] as string | undefined)

    if (!token) {
      // Unauthenticated showcase request — continue without session
      this.logger.debug('[ShadowSession] No legacy token present — unauthenticated showcase request')
      return next()
    }

    // ── Verification via LegacyShowcaseAdapter ────────────────────────────
    let verified: VerifiedToken
    try {
      verified = await this.legacyAdapter.verifyToken(token)
    } catch {
      // Invalid legacy token — continue without session.
      // Showcase routes that require auth will check req.showcaseSession and reject.
      this.logger.debug('[ShadowSession] Legacy token verification failed — proceeding unauthenticated')
      return next()
    }

    // ── Populate isolated session object ─────────────────────────────────
    req.showcaseSession = {
      legacyUserId: verified.externalId,   // Legacy: externalId === internalId (UUID)
      email:        verified.email,
      role:         verified.role,
      jti:          verified.jti ?? '',
      expiresAt:    verified.expiresAt ?? new Date(Date.now() + 900_000).toISOString(),
      sessionCtx:   'legacy_showcase',
    }

    this.logger.debug(
      `[ShadowSession] Resolved legacy session for ${verified.email} (${verified.externalId})`,
    )

    return next()
  }
}
