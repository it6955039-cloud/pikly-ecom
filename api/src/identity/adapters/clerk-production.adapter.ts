/**
 * @file clerk-production.adapter.ts
 * @layer Infrastructure / Adapter (Primary)
 *
 * ClerkProductionAdapter — implements IIdentityService using Clerk as the
 * Identity Provider. This is THE production authentication path.
 *
 * Token verification strategy:
 *   Clerk issues RS256 JWTs signed with a rotating JWKS. We fetch the JWKS
 *   from Clerk's well-known endpoint, cache it in-memory with a 1-hour TTL,
 *   and verify locally — zero round-trips per request.
 *
 * SOLID compliance:
 *   S — Single Responsibility: token verification + user provisioning only.
 *   O — Open/Closed: extend by swapping this adapter, not by modifying port.
 *   L — Liskov: conforms strictly to IIdentityService contract.
 *   I — Interface Segregation: IIdentityService is minimal; adapters add nothing.
 *   D — Dependency Inversion: depends on IIdentityService abstraction.
 */

import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as jose from 'jose'
import {
  IIdentityService,
  ProvisionPayload,
  VerifiedToken,
} from '../ports/identity.port'
import {
  ClerkJwtPayloadSchema,
} from '../schemas/identity.schemas'
import { IdentityMappingService } from '../gim/identity-mapping.service'
import { OutboxService } from '../outbox/outbox.service'

@Injectable()
export class ClerkProductionAdapter extends IIdentityService {
  readonly isProductionAdapter = true

  private readonly logger = new Logger(ClerkProductionAdapter.name)

  /**
   * JWKS cache: key = kid, value = KeyLike.
   * We store the full RemoteJWKSet so jose handles rotation internally.
   * Refreshed on each invalid-kid error (jose's default).
   */
  private readonly jwksClient: ReturnType<typeof jose.createRemoteJWKSet>

  constructor(
    private readonly config: ConfigService,
    private readonly gim: IdentityMappingService,
    private readonly outbox: OutboxService,
  ) {
    super()

    const issuer = this.config.getOrThrow<string>('CLERK_ISSUER_URL')
    // e.g. https://clerk.your-domain.com — Clerk JWKS endpoint is /.well-known/jwks.json
    this.jwksClient = jose.createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`),
      {
        // Cache keys for 1 hour; re-fetch on unknown kid
        cacheMaxAge: 3_600_000,
      },
    )
  }

  // ── IIdentityService implementation ─────────────────────────────────────

  async verifyToken(rawToken: string): Promise<VerifiedToken> {
    const issuer   = this.config.getOrThrow<string>('CLERK_ISSUER_URL')
    const audience = this.config.get<string>('CLERK_AUDIENCE')  // optional

    let payload: jose.JWTPayload
    try {
      const result = await jose.jwtVerify(rawToken, this.jwksClient, {
        issuer,
        ...(audience ? { audience } : {}),
        algorithms: ['RS256'],
      })
      payload = result.payload
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Clerk JWT verification failed: ${msg}`)
      throw new UnauthorizedException({
        code:    'INVALID_CLERK_TOKEN',
        message: 'Token verification failed',
      })
    }

    // Validate the shape we care about
    const parsed = ClerkJwtPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      this.logger.warn(`Clerk JWT payload shape invalid: ${parsed.error.message}`)
      throw new UnauthorizedException({ code: 'MALFORMED_CLERK_TOKEN' })
    }

    const claims = parsed.data

    // Resolve email — Clerk may put it in `email` or `email_addresses[0]`
    const email =
      claims.email ??
      claims.email_addresses?.[0]?.email_address

    if (!email) {
      throw new UnauthorizedException({ code: 'CLERK_TOKEN_NO_EMAIL' })
    }

    const role = claims.public_metadata?.role ?? 'customer'
    const expiresAt = new Date(claims.exp * 1000).toISOString()

    return {
      externalId: claims.sub,
      email,
      role,
      jti:       claims.jti,
      expiresAt,
    }
  }

  async provisionUser(payload: ProvisionPayload): Promise<string> {
    // GIM handles idempotency — safe to call multiple times
    const internalId = await this.gim.upsertMapping({
      externalId: payload.externalId,
      email:      payload.email,
      firstName:  payload.firstName,
      lastName:   payload.lastName,
      role:       payload.role,
      avatarUrl:  payload.avatarUrl,
    })

    // Write to Outbox so any downstream sync can process asynchronously.
    // This is NOT awaited past the DB write — the outbox processor handles the rest.
    await this.outbox.enqueue({
      eventType:   'user.provisioned',
      aggregateId: internalId,
      externalId:  payload.externalId,
      payload:     { email: payload.email, source: payload.source },
    })

    return internalId
  }

  async revokeSession(_jti: string, externalId: string): Promise<void> {
    // For Clerk, session revocation happens via Clerk's API.
    // In a full implementation, call: DELETE /v1/sessions/:session_id
    // We make this best-effort (errors are swallowed per contract).
    try {
      const secretKey = this.config.getOrThrow<string>('CLERK_SECRET_KEY')
      // Find active sessions for this user and revoke them
      // This is a simplified call — production would also persist the Clerk session ID
      const resp = await fetch(
        `https://api.clerk.com/v1/users/${externalId}/sessions`,
        {
          method:  'GET',
          headers: { Authorization: `Bearer ${secretKey}` },
        },
      )
      if (!resp.ok) return

      const sessions = (await resp.json()) as Array<{ id: string; status: string }>
      const active   = sessions.filter((s) => s.status === 'active')

      await Promise.allSettled(
        active.map((session) =>
          fetch(`https://api.clerk.com/v1/sessions/${session.id}/revoke`, {
            method:  'POST',
            headers: { Authorization: `Bearer ${secretKey}` },
          }),
        ),
      )
    } catch (err) {
      this.logger.warn(`Clerk session revocation failed (best-effort): ${String(err)}`)
    }
  }
}
