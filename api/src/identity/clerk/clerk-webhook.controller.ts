/**
 * @file clerk-webhook.controller.ts
 * @layer Infrastructure / Clerk Integration
 *
 * BUG-2 FIX: handleUserCreated() now calls identityService.provisionUser()
 *   with reactivate: true. This propagates to GIM.upsertMapping(reactivate=true)
 *   which sets is_active = true on store.users in the ON CONFLICT DO UPDATE
 *   clause. Without this, a user deleted from Clerk who re-registers with the
 *   same email gets permanently stuck with is_active = false → 403 on every
 *   API call forever.
 *
 *   WHY this is safe: The user.created webhook is ONLY fired by Clerk when a
 *   brand-new Clerk account is created. A deactivated user who merely logs in
 *   with their existing Clerk JWT does NOT trigger user.created — they get
 *   blocked by JitProvisioningGuard.isDeactivated(). The user.created path
 *   represents a genuine new signup decision by the user (they went through
 *   Clerk's registration flow again), so re-activation is correct.
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

const SVIX_ID_HEADER = 'webhook-id'
const SVIX_TIMESTAMP_HEADER = 'webhook-timestamp'
const SVIX_SIGNATURE_HEADER = 'webhook-signature'

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1_000

@ApiExcludeController()
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
    @Headers(SVIX_ID_HEADER) svixId: string,
    @Headers(SVIX_TIMESTAMP_HEADER) svixTimestamp: string,
    @Headers(SVIX_SIGNATURE_HEADER) svixSignature: string,
  ): Promise<void> {
    const rawBody = req.rawBody
    if (!rawBody) {
      throw new BadRequestException({
        code: 'MISSING_RAW_BODY',
        message:
          'Raw body is required for Svix signature verification. ' +
          'Ensure rawBody: true is set in NestFactory.create().',
      })
    }

    await this.verifySvixSignature(rawBody, svixId, svixTimestamp, svixSignature)

    let body: unknown
    try {
      body = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      throw new BadRequestException({ code: 'INVALID_JSON' })
    }

    const envelope = ClerkWebhookEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      this.logger.warn(`Unknown webhook type: ${(body as any)?.type ?? 'undefined'}`)
      return
    }

    const { type, data } = envelope.data
    this.logger.log(`[ClerkWebhook] Received: ${type}`)

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

    const user = parsed.data
    const email = user.email_addresses[0]!.email_address
    const firstName = user.first_name ?? email.split('@')[0] ?? 'User'
    const lastName = user.last_name ?? ''
    const role = user.public_metadata?.role ?? 'customer'

    // BUG-2 FIX: Pass reactivate: true so that if this email already exists
    // in store.users (from a previous Clerk account that was deleted), the
    // is_active flag is restored to true. See ProvisionPayload.reactivate
    // for the full security rationale — JIT must never set this flag.
    await this.identityService.provisionUser({
      externalId: user.id,
      email,
      firstName,
      lastName,
      role,
      avatarUrl: user.image_url ?? undefined,
      source: 'clerk_webhook',
      reactivate: true, // ← BUG-2 FIX
    })

    this.logger.log(`[ClerkWebhook] Provisioned user: ${user.id} (${email})`)
  }

  private async handleUserUpdated(data: Record<string, unknown>): Promise<void> {
    const parsed = ClerkUserUpdatedDataSchema.safeParse(data)
    if (!parsed.success) return

    const user = parsed.data
    const email = user.email_addresses[0]!.email_address
    const firstName = user.first_name ?? ''
    const lastName = user.last_name ?? ''
    const role = user.public_metadata?.role ?? 'customer'

    // reactivate intentionally NOT set here — user.updated must not
    // re-activate a deactivated account.
    const internalId = await this.gim.upsertMapping({
      externalId: user.id,
      email,
      firstName,
      lastName,
      role,
      avatarUrl: user.image_url ?? undefined,
    })

    await this.outbox.enqueue({
      eventType: 'user.updated',
      aggregateId: internalId,
      externalId: user.id,
      payload: { email, firstName, lastName, role },
    })

    this.logger.log(`[ClerkWebhook] Updated user: ${user.id} → ${internalId}`)
  }

  private async handleSessionEnded(data: Record<string, unknown>): Promise<void> {
    const parsed = ClerkSessionDeletedDataSchema.safeParse(data)
    if (!parsed.success) return

    await this.identityService.revokeSession(parsed.data.id, parsed.data.user_id)
    this.logger.log(`[ClerkWebhook] Session revoked: ${parsed.data.id}`)
  }

  private async handleUserDeleted(data: Record<string, unknown>): Promise<void> {
    const externalId = (data as any)?.id as string | undefined
    if (!externalId) return

    // BUG-1 FIX: deactivateMapping() now deactivates ALL identity_mapping rows
    // for the user (not just the one matching externalId). This prevents a
    // re-registered user from retaining an active mapping for their new Clerk ID.
    await this.gim.deactivateMapping(externalId)

    this.logger.log(`[ClerkWebhook] Deactivated all mappings for: ${externalId}`)
  }

  // ── Svix Signature Verification ────────────────────────────────────────────

  private async verifySvixSignature(
    body: Buffer,
    svixId: string,
    svixTimestamp: string,
    svixSignature: string,
  ): Promise<void> {
    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException({
        code: 'MISSING_SVIX_HEADERS',
        message: 'webhook-id, webhook-timestamp, and webhook-signature are required',
      })
    }

    const timestampMs = parseInt(svixTimestamp, 10) * 1000
    if (Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_DRIFT_MS) {
      throw new BadRequestException({
        code: 'WEBHOOK_TIMESTAMP_EXPIRED',
        message: 'Webhook timestamp is too old or too far in the future',
      })
    }

    const webhookSecret = this.config.getOrThrow<string>('CLERK_WEBHOOK_SECRET')

    const secretBytes = Buffer.from(
      webhookSecret.startsWith('whsec_') ? webhookSecret.slice(6) : webhookSecret,
      'base64',
    )

    const signedContent = Buffer.from(`${svixId}.${svixTimestamp}.${body.toString('utf-8')}`)

    const computedHmac = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64')

    const signatures = svixSignature.split(' ')
    const isValid = signatures.some((sig) => {
      const sigValue = sig.startsWith('v1,') ? sig.slice(3) : sig
      try {
        return crypto.timingSafeEqual(Buffer.from(computedHmac), Buffer.from(sigValue))
      } catch {
        // Buffer lengths differ (malformed base64) — treat as invalid
        return false
      }
    })

    if (!isValid) {
      throw new BadRequestException({
        code: 'INVALID_SVIX_SIGNATURE',
        message: 'Webhook signature verification failed',
      })
    }
  }
}
