/**
 * @file clerk-production.adapter.ts
 *
 * BUG-2 FIX: provisionUser() now forwards payload.reactivate to
 * gim.upsertMapping(). Without this, the reactivate flag set by
 * ClerkWebhookController.handleUserCreated() was silently dropped.
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as jose from 'jose'
import { IIdentityService, ProvisionPayload, VerifiedToken } from '../ports/identity.port'
import { ClerkJwtPayloadSchema } from '../schemas/identity.schemas'
import { IdentityMappingService } from '../gim/identity-mapping.service'
import { OutboxService } from '../outbox/outbox.service'

@Injectable()
export class ClerkProductionAdapter extends IIdentityService {
  readonly isProductionAdapter = true

  private readonly logger = new Logger(ClerkProductionAdapter.name)
  private readonly jwksClient: ReturnType<typeof jose.createRemoteJWKSet>

  constructor(
    private readonly config: ConfigService,
    private readonly gim: IdentityMappingService,
    private readonly outbox: OutboxService,
  ) {
    super()

    const issuer = this.config.getOrThrow<string>('CLERK_ISSUER_URL')
    this.jwksClient = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      cacheMaxAge: 3_600_000, // 1-hour JWKS cache
    })
  }

  async verifyToken(rawToken: string): Promise<VerifiedToken> {
    const issuer = this.config.getOrThrow<string>('CLERK_ISSUER_URL')
    const audience = this.config.get<string>('CLERK_AUDIENCE')

    let payload: jose.JWTPayload
    try {
      const result = await jose.jwtVerify(rawToken, this.jwksClient, {
        issuer,
        ...(audience ? { audience } : {}),
      })
      payload = result.payload
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`Clerk JWT verification failed: ${msg}`)
      throw new UnauthorizedException({
        code: 'INVALID_CLERK_TOKEN',
        message: 'Token verification failed',
      })
    }

    const parsed = ClerkJwtPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      this.logger.warn(`Clerk JWT payload shape invalid: ${parsed.error.message}`)
      throw new UnauthorizedException({ code: 'MALFORMED_CLERK_TOKEN' })
    }

    const claims = parsed.data
    const email = claims.email ?? claims.email_addresses?.[0]?.email_address

    if (!email) {
      throw new UnauthorizedException({ code: 'CLERK_TOKEN_NO_EMAIL' })
    }

    const role = claims.public_metadata?.role ?? 'customer'
    const expiresAt = new Date(claims.exp * 1000).toISOString()

    return { externalId: claims.sub, email, role, jti: claims.jti, expiresAt }
  }

  async provisionUser(payload: ProvisionPayload): Promise<string> {
    // BUG-2 FIX: Forward reactivate flag to upsertMapping so that genuine
    // Clerk re-registrations (user.created webhook with reactivate=true)
    // correctly restore is_active = true on store.users.
    const internalId = await this.gim.upsertMapping({
      externalId: payload.externalId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      role: payload.role,
      avatarUrl: payload.avatarUrl,
      reactivate: payload.reactivate ?? false, // ← BUG-2 FIX
    })

    await this.outbox.enqueue({
      eventType: 'user.provisioned',
      aggregateId: internalId,
      externalId: payload.externalId,
      payload: { email: payload.email, source: payload.source },
    })

    return internalId
  }

  async revokeSession(_jti: string, externalId: string): Promise<void> {
    try {
      const secretKey = this.config.getOrThrow<string>('CLERK_SECRET_KEY')
      const resp = await fetch(`https://api.clerk.com/v1/users/${externalId}/sessions`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secretKey}` },
      })
      if (!resp.ok) return

      const sessions = (await resp.json()) as Array<{ id: string; status: string }>
      const active = sessions.filter((s) => s.status === 'active')

      await Promise.allSettled(
        active.map((session) =>
          fetch(`https://api.clerk.com/v1/sessions/${session.id}/revoke`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secretKey}` },
          }),
        ),
      )
    } catch (err) {
      this.logger.warn(`Clerk session revocation failed (best-effort): ${String(err)}`)
    }
  }
}
