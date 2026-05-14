/**
 * @file identity.port.ts
 * @layer Domain / Port
 *
 * THE SINGLE SOURCE OF TRUTH FOR AUTH CONTRACTS IN THIS SYSTEM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BUGS FIXED IN THIS FILE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  BUG-2 (CRITICAL) — ProvisionPayload missing reactivate flag
 *    Root cause: no way for ClerkWebhookController.handleUserCreated() to
 *    signal to GIM.upsertMapping() that this is a genuine re-registration that
 *    should restore is_active = true on the existing store.users row.
 *    Fix: Added reactivate?: boolean to ProvisionPayload. Only the
 *    user.created webhook handler sets this true. JIT guard never sets it.
 *    Also added 'admin' as a valid source to match AdminUsersController usage.
 *
 *  BUG-SCHEMA (LOW) — lastName z.string().min(1) rejects empty string
 *    Root cause: JitProvisioningGuard passes lastName: '' (empty string,
 *    correct for JIT — real name arrives via user.created webhook later).
 *    z.string().min(1) would reject this if ProvisionPayloadSchema.parse()
 *    were called at runtime. While no code currently calls parse() on this
 *    schema (type is inferred from it), the mismatch is a latent bug and
 *    would break any future validation. Fixed: changed to z.string().max(100).
 */

import { z } from 'zod'

// ── Zod Schemas ───────────────────────────────────────────────────────────────

export const ResolvedIdentitySchema = z.object({
  internalId: z.string().uuid(),
  externalId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['customer', 'admin']),
  sessionCtx: z.enum(['clerk_production', 'legacy_showcase']),
  expiresAt: z.string().datetime().optional(),
  jti: z.string().optional(),
})

export type ResolvedIdentity = z.infer<typeof ResolvedIdentitySchema>

export const ProvisionPayloadSchema = z.object({
  externalId: z.string().min(1),
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  /**
   * BUG-SCHEMA FIX: changed min(1) → no minimum. JIT provisioning passes '' for
   * lastName (correct — the real name arrives via the user.created webhook).
   * z.string().min(1) would reject empty strings at runtime if parse() is called.
   */
  lastName: z.string().max(100),
  role: z.enum(['customer', 'admin']).default('customer'),
  avatarUrl: z.string().url().optional(),
  /**
   * 'admin' added — AdminUsersController can provision users on behalf of admins.
   * 'legacy_migration' kept for backward compatibility with any existing data.
   */
  source: z.enum(['clerk_webhook', 'jit_guard', 'admin', 'legacy_migration']),
  /**
   * BUG-2 FIX — When true, GIM.upsertMapping() adds is_active = true to the
   * ON CONFLICT DO UPDATE clause, restoring a previously deactivated account.
   *
   * MUST only be set by ClerkWebhookController.handleUserCreated() — which
   * represents a genuine new Clerk account creation. JIT guard MUST NOT set
   * this flag — that would allow a deactivated user to self-reactivate by
   * simply making any API call with a still-valid Clerk JWT.
   */
  reactivate: z.boolean().optional(),
})

export type ProvisionPayload = z.infer<typeof ProvisionPayloadSchema>

export const VerifiedTokenSchema = z.object({
  externalId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['customer', 'admin']),
  jti: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
})

export type VerifiedToken = z.infer<typeof VerifiedTokenSchema>

// ── DI Token ──────────────────────────────────────────────────────────────────

export const SHOWCASE_IDENTITY_SERVICE = 'SHOWCASE_IDENTITY_SERVICE' as const

// ── Port (Abstract Base Class) ────────────────────────────────────────────────

/**
 * IIdentityService — the abstract Port that all adapters implement.
 *
 * INVARIANTS:
 *   1. verifyToken() MUST throw if the token is invalid/expired.
 *   2. provisionUser() MUST be idempotent (safe to call multiple times with
 *      the same externalId — used by JIT Guard on every authenticated request).
 *   3. revokeSession() is a best-effort operation; implementations MUST NOT
 *      throw if the session is already gone.
 *   4. isProductionAdapter: exactly one adapter returns true at any time.
 */
export abstract class IIdentityService {
  abstract readonly isProductionAdapter: boolean
  abstract verifyToken(rawToken: string): Promise<VerifiedToken>
  abstract provisionUser(payload: ProvisionPayload): Promise<string>
  abstract revokeSession(jti: string, externalId: string): Promise<void>
}
