/**
 * @file identity.schemas.ts
 * @layer Infrastructure / Validation
 *
 * Centralised Zod schemas for all external payloads touching the identity
 * pipeline. Separating schemas from port definitions keeps the port file
 * framework-agnostic and makes these schemas independently testable.
 */

import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Clerk JWT Claims
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of the JWT payload Clerk issues. Fields we care about:
 *   sub     — Clerk user ID (e.g. user_2abc123...)
 *   email   — Primary email (from publicMetadata or email_addresses)
 *   role    — Our custom claim set in Clerk session customisation
 *
 * We deliberately do NOT validate every Clerk claim — only what the
 * Identity Abstraction Layer consumes. Unknown claims are stripped by Zod.
 */
export const ClerkJwtPayloadSchema = z.object({
  sub:              z.string().min(1),
  email:            z.string().email().optional(),
  jti:              z.string().optional(),
  exp:              z.number().int().positive(),
  iat:              z.number().int().positive(),
  /**
   * Custom claim injected via Clerk's session customization template:
   * `{{ user.public_metadata.role }}`
   */
  'public_metadata': z.object({
    role: z.enum(['customer', 'admin']).optional(),
  }).optional(),
  /** Email may appear under email_addresses[0].email_address in some flows */
  email_addresses:  z.array(z.object({
    email_address: z.string().email(),
  })).optional(),
})

export type ClerkJwtPayload = z.infer<typeof ClerkJwtPayloadSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Clerk Svix Webhook Payloads
// ─────────────────────────────────────────────────────────────────────────────

const ClerkEmailAddressSchema = z.object({
  id:              z.string(),
  email_address:   z.string().email(),
  verification:    z.object({ status: z.string() }).optional(),
})

export const ClerkUserCreatedDataSchema = z.object({
  id:               z.string().min(1),  // Clerk user ID
  email_addresses:  z.array(ClerkEmailAddressSchema).min(1),
  first_name:       z.string().nullable().optional(),
  last_name:        z.string().nullable().optional(),
  image_url:        z.string().url().nullable().optional(),
  public_metadata:  z.object({
    role: z.enum(['customer', 'admin']).optional(),
  }).optional(),
})

export const ClerkUserUpdatedDataSchema = ClerkUserCreatedDataSchema

export const ClerkSessionDeletedDataSchema = z.object({
  id:      z.string().min(1),  // Session ID
  user_id: z.string().min(1),
})

/**
 * Top-level Svix webhook envelope. We validate the type first, then
 * narrowly parse the `data` field based on the type discriminant.
 */
export const ClerkWebhookEnvelopeSchema = z.object({
  type: z.enum(['user.created', 'user.updated', 'session.ended', 'user.deleted']),
  data: z.record(z.unknown()),  // Parsed with narrow schemas per type
})

export type ClerkWebhookEnvelope = z.infer<typeof ClerkWebhookEnvelopeSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Legacy JWT Claims (existing system — kept for showcase adapter)
// ─────────────────────────────────────────────────────────────────────────────

export const LegacyJwtPayloadSchema = z.object({
  sub:   z.string().uuid(),
  email: z.string().email(),
  role:  z.enum(['customer', 'admin']),
  jti:   z.string().uuid(),
  exp:   z.number().int().positive(),
  iat:   z.number().int().positive(),
})

export type LegacyJwtPayload = z.infer<typeof LegacyJwtPayloadSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Transactional Outbox Record
// ─────────────────────────────────────────────────────────────────────────────

export const OutboxEventTypeSchema = z.enum([
  'user.provisioned',
  'user.updated',
  'user.deactivated',
])

export const OutboxRecordSchema = z.object({
  id:          z.string().uuid(),
  eventType:   OutboxEventTypeSchema,
  aggregateId: z.string(),        // internal UUID
  externalId:  z.string(),        // Clerk ID
  payload:     z.record(z.unknown()),
  createdAt:   z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
  attempts:    z.number().int().min(0),
  lastError:   z.string().nullable(),
})

export type OutboxRecord = z.infer<typeof OutboxRecordSchema>
