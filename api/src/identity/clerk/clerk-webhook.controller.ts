/**
 * @file clerk-webhook.controller.ts
 * @layer Infrastructure / Clerk Integration
 *
 * Clerk Webhook Receiver — handles Svix-signed events from Clerk.
 *
 * Events handled:
 *   user.created   → provision user in store.users + GIM + Outbox
 *   user.updated   → sync email/name/role changes
 *   session.ended  → revoke session (best-effort)
 *   user.deleted   → soft-delete identity mapping
 *
 * Svix signature verification:
 *   Every Clerk webhook is signed using the Webhook-Id, Webhook-Timestamp,
 *   and Webhook-Signature headers via HMAC-SHA256. We verify before parsing
 *   the body — malformed or unsigned payloads are rejected with 400.
 *
 * Idempotency:
 *   Svix guarantees at-least-once delivery. All handlers use upsertMapping()
 *   (ON CONFLICT DO UPDATE) so duplicate deliveries are safe.
 *
 * Raw body requirement:
 *   Svix signature verification requires the raw request body as a Buffer.
 *   NestJS's default JSON parser consumes the body stream. We apply
 *   the rawBodyMiddleware ONLY to this route in IdentityModule.configure().
 */

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Request } from 'express'
import * as crypto from 'crypto'
import { ConfigService } from '@nestjs/config'
import { IIdentityService } from '../ports/identity.port'
import {
  ClerkWebhookEnvelopeSchema,
  ClerkUserCreatedDataSchema,
  ClerkUserUpdatedDataSchema,
  ClerkSessionDeletedDataSchema,
} from '../schemas/identity.schemas'
import { IdentityMappingService } from '../gim/identity-mapping.service'
import { OutboxService } from '../outbox/outbox.service'

/** Header names per Svix specification */
const SVIX_ID_HEADER        = 'webhook-id'
const SVIX_TIMESTAMP_HEADER = 'webhook-timestamp'
const SVIX_SIGNATURE_HEADER = 'webhook-signature'

/** Reject webhooks older than 5 minutes (replay attack protection) */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1_000

@ApiExcludeController()   // Exclude from Swagger — this is an internal endpoint
@Controller('clerk/webhooks')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name)

  constructor(
    private readonly config: ConfigService,
    private readonly identityService: IIdentityService,
    private readonly gim: IdentityMappingService,
    private readonly outbox: OutboxService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers(SVIX_ID_HEADER)        svixId:        string,
    @Headers(SVIX_TIMESTAMP_HEADER) svixTimestamp: string,
    @Headers(SVIX_SIGNATURE_HEADER) svixSignature: string,
  ): Promise<void> {
    // ── Svix signature verification ────────────────────────────────────────
    const rawBody = req.rawBody
    if (!rawBody) {
      throw new BadRequestException({
        code:    'MISSING_RAW_BODY',
        message: 'Raw body is required for Svix signature verification',
      })
    }

    await this.verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature)

    // ── Parse envelope ─────────────────────────────────────────────────────
    let body: unknown
    try {
      body = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      throw new BadRequestException({ code: 'INVALID_JSON' })
    }

    const envelope = ClerkWebhookEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      this.logger.warn(`Unknown webhook type: ${(body as any)?.type ?? 'undefined'}`)
      // Return 204 — Svix will not retry for unrecognised types
      return
    }

    const { type, data } = envelope.data
    this.logger.log(`[ClerkWebhook] Received: ${type}`)

    // ── Dispatch ────────────────────────────────────────────────────────────
    switch (type) {
      case 'user.created':
        await this.handleUserCreated(data)
        break
      case 'user.updated':
        await this.handleUserUpdated(data)
        break
      case 'session.ended':
        await this.handleSessionEnded(data)
        break
      case 'user.deleted':
        await this.handleUserDeleted(data)
        break
    }
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  private async handleUserCreated(data: Record<string, unknown>): Promise<void> {
    const parsed = ClerkUserCreatedDataSchema.safeParse(data)
    if (!parsed.success) {
      this.logger.error(`[ClerkWebhook] user.created payload invalid: ${parsed.error.message}`)
      return
    }

    const user      = parsed.data
    const email     = user.email_addresses[0]!.email_address
    const firstName = user.first_name ?? email.split('@')[0] ?? 'User'
    const lastName  = user.last_name  ?? ''
    const role      = user.public_metadata?.role ?? 'customer'

    await this.identityService.provisionUser({
      externalId: user.id,
      email,
      firstName,
      lastName,
      role,
      avatarUrl:  user.image_url ?? undefined,
      source:     'clerk_webhook',
    })

    this.logger.log(`[ClerkWebhook] Provisioned user: ${user.id} (${email})`)
  }

  private async handleUserUpdated(data: Record<string, unknown>): Promise<void> {
    const parsed = ClerkUserUpdatedDataSchema.safeParse(data)
    if (!parsed.success) return

    const user      = parsed.data
    const email     = user.email_addresses[0]!.email_address
    const firstName = user.first_name ?? ''
    const lastName  = user.last_name  ?? ''
    const role      = user.public_metadata?.role ?? 'customer'

    // upsertMapping handles both create (race) and update
    const internalId = await this.gim.upsertMapping({
      externalId: user.id,
      email,
      firstName,
      lastName,
      role,
      avatarUrl:  user.image_url ?? undefined,
    })

    await this.outbox.enqueue({
      eventType:   'user.updated',
      aggregateId: internalId,
      externalId:  user.id,
      payload:     { email, firstName, lastName, role },
    })

    this.logger.log(`[ClerkWebhook] Updated user: ${user.id} → ${internalId}`)
  }

  private async handleSessionEnded(data: Record<string, unknown>): Promise<void> {
    const parsed = ClerkSessionDeletedDataSchema.safeParse(data)
    if (!parsed.success) return

    // Best-effort revocation — errors are swallowed by revokeSession contract
    await this.identityService.revokeSession(parsed.data.id, parsed.data.user_id)
    this.logger.log(`[ClerkWebhook] Session revoked: ${parsed.data.id}`)
  }

  private async handleUserDeleted(data: Record<string, unknown>): Promise<void> {
    const externalId = (data as any)?.id as string | undefined
    if (!externalId) return

    await this.gim.deactivateMapping(externalId)

    this.logger.log(`[ClerkWebhook] Deactivated user: ${externalId}`)
  }

  // ── Svix Signature Verification ────────────────────────────────────────────

  /**
   * Implements Svix webhook verification per:
   * https://docs.svix.com/receiving/verifying-payloads/how
   *
   * Signed string: `{id}.{timestamp}.{body}`
   * Each signature in the header is a base64-encoded HMAC-SHA256.
   *
   * Multiple signatures may be present (key rotation) — any valid one passes.
   */
  private async verifySvixSignature(
    body:          Buffer,
    svixId:        string,
    svixTimestamp: string,
    svixSignature: string,
  ): Promise<void> {
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException({
        code:    'MISSING_SVIX_HEADERS',
        message: 'webhook-id, webhook-timestamp, and webhook-signature are required',
      })
    }

    // Replay attack protection
    const timestampMs = parseInt(svixTimestamp, 10) * 1000
    if (Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_DRIFT_MS) {
      throw new BadRequestException({
        code:    'WEBHOOK_TIMESTAMP_EXPIRED',
        message: 'Webhook timestamp is too old or too far in the future',
      })
    }

    const webhookSecret = this.config.getOrThrow<string>('CLERK_WEBHOOK_SECRET')

    // Svix secrets are prefixed with "whsec_" — strip prefix and decode base64
    const secretBytes = Buffer.from(
      webhookSecret.startsWith('whsec_')
        ? webhookSecret.slice(6)
        : webhookSecret,
      'base64',
    )

    // Signed content: id + "." + timestamp + "." + raw body
    const signedContent = Buffer.from(`${svixId}.${svixTimestamp}.${body.toString('utf-8')}`)

    const computedHmac = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64')

    // Header contains space-separated signatures: "v1,<base64> v1,<base64>"
    const signatures = svixSignature.split(' ')
    const isValid = signatures.some((sig) => {
      const sigValue = sig.startsWith('v1,') ? sig.slice(3) : sig
      return crypto.timingSafeEqual(
        Buffer.from(computedHmac),
        Buffer.from(sigValue),
      )
    })

    if (!isValid) {
      throw new BadRequestException({
        code:    'INVALID_SVIX_SIGNATURE',
        message: 'Webhook signature verification failed',
      })
    }
  }
}
