/**
 * @file identity.port.ts
 * @layer Domain / Port
 *
 * THE SINGLE SOURCE OF TRUTH FOR AUTH CONTRACTS IN THIS SYSTEM.
 *
 * This file defines the Hexagonal Port for the Identity domain. It is
 * deliberately stripped of any framework references (NestJS, Clerk, Passport).
 * The Domain layer NEVER imports from adapters — only from this file.
 *
 * Architecture Decision:
 *   We use a TypeScript `abstract class` rather than `interface` so that
 *   NestJS's DI container can use it as an injection token at runtime
 *   (interfaces are erased at compile time; abstract classes produce a
 *   runtime symbol that Reflect can resolve).
 */

import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas — single source of structural truth, used by both adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical identity object that flows through the system.
 * Both ClerkProductionAdapter and LegacyShowcaseAdapter must produce
 * a value that conforms to this schema.
 *
 * `internalId`  — The UUID from store.users (our FK across all tables)
 * `externalId`  — The IdP-native ID (Clerk K-sortable string OR legacy UUID)
 * `sessionCtx`  — Which security context produced this identity (never mix them)
 */
export const ResolvedIdentitySchema = z.object({
  internalId:  z.string().uuid(),
  externalId:  z.string().min(1),
  email:       z.string().email(),
  role:        z.enum(['customer', 'admin']),
  sessionCtx:  z.enum(['clerk_production', 'legacy_showcase']),
  /** ISO-8601 token expiry — lets middleware make fine-grained caching decisions */
  expiresAt:   z.string().datetime().optional(),
  /** Opaque token ID for blacklist / revocation lookups */
  jti:         z.string().optional(),
})

export type ResolvedIdentity = z.infer<typeof ResolvedIdentitySchema>

/**
 * Provisioning payload emitted when a user is first seen (JIT path).
 * The GIM layer writes this to store.identity_mapping atomically.
 */
export const ProvisionPayloadSchema = z.object({
  externalId: z.string().min(1),
  email:      z.string().email(),
  firstName:  z.string().min(1).max(100),
  lastName:   z.string().min(1).max(100),
  role:       z.enum(['customer', 'admin']).default('customer'),
  avatarUrl:  z.string().url().optional(),
  source:     z.enum(['clerk_webhook', 'jit_guard', 'legacy_migration']),
})

export type ProvisionPayload = z.infer<typeof ProvisionPayloadSchema>

/**
 * Token verification result — what adapters return to the middleware.
 * Distinct from ResolvedIdentity: at this stage we have not yet resolved
 * the internal UUID (that is the GIM layer's responsibility).
 */
export const VerifiedTokenSchema = z.object({
  externalId: z.string().min(1),
  email:      z.string().email(),
  role:       z.enum(['customer', 'admin']),
  jti:        z.string().optional(),
  expiresAt:  z.string().datetime().optional(),
})

export type VerifiedToken = z.infer<typeof VerifiedTokenSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Port Definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IIdentityService — the abstract Port that all adapters implement.
 *
 * INVARIANTS:
 *   1. verifyToken() MUST throw if the token is invalid/expired.
 *   2. provisionUser() MUST be idempotent (safe to call multiple times
 *      with the same externalId — used by JIT Guard).
 *   3. revokeSession() is a best-effort operation; implementations
 *      MUST NOT throw if the session is already gone.
 */
export abstract class IIdentityService {
  /**
   * Verify an inbound token (JWT, session cookie, etc.) and return the
   * structured claims. Throws on any validation failure.
   */
  abstract verifyToken(rawToken: string): Promise<VerifiedToken>

  /**
   * Idempotently create or update a local user record for the given
   * externalId. Used by both the Clerk webhook receiver and the JIT Guard.
   * Returns the internal UUID.
   */
  abstract provisionUser(payload: ProvisionPayload): Promise<string>

  /**
   * Revoke a session. For Clerk: revoke the server-side session.
   * For Legacy: blacklist the JWT jti in Redis.
   * Best-effort — must not throw.
   */
  abstract revokeSession(jti: string, externalId: string): Promise<void>

  /**
   * True if this adapter is active in the Production security context.
   * Only one adapter should return true at any time.
   * Used by the middleware to decide routing — never checked in domain code.
   */
  abstract readonly isProductionAdapter: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// DI Token for the showcase adapter (secondary, isolated injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Because NestJS can only have one provider per token, we use a string
 * token for the secondary (showcase) adapter so both can coexist.
 */
export const SHOWCASE_IDENTITY_SERVICE = 'SHOWCASE_IDENTITY_SERVICE' as const
