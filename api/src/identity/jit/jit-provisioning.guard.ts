/**
 * @file jit-provisioning.guard.ts
 * @layer Infrastructure / Guards
 *
 * Just-In-Time Provisioning Guard
 *
 * Race Condition Problem:
 *   Clerk completes OAuth/sign-up → redirects user to the app.
 *   The Svix webhook (user.created) is in-flight but has NOT arrived yet.
 *   The user hits a protected endpoint. GIM.resolve() returns null.
 *   Without this guard, the request fails with 404/401.
 *
 * Solution — Chain of Responsibility:
 *   1. ClerkAuthMiddleware runs first — verifies the JWT, attaches VerifiedToken
 *      to request as req.verifiedToken.
 *   2. This guard runs second (after middleware, before controller).
 *   3. If GIM resolves the externalId → proceed normally.
 *   4. If GIM returns null → call IIdentityService.provisionUser() RIGHT NOW.
 *      This is the "Just-In-Time" provision step.
 *   5. The provisioned user is written to DB + identity_mapping atomically.
 *   6. The Outbox records the event so any secondary systems stay consistent.
 *   7. If a concurrent request already provisioned the user (race-on-race),
 *      the upsertMapping() ON CONFLICT handles it gracefully.
 *
 * Idempotency guarantee:
 *   upsertMapping() uses PostgreSQL ON CONFLICT DO UPDATE — safe under any
 *   concurrency level. The guard produces exactly the same result whether
 *   called once or 100 times for the same externalId.
 *
 * This guard is ONLY applied to production routes (not /showcase/*).
 * The ShadowSessionMiddleware handles showcase route identity separately.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ModuleRef, ContextIdFactory, Reflector } from '@nestjs/core'
import { IIdentityService, ResolvedIdentity, ResolvedIdentitySchema } from '../ports/identity.port'
import { IdentityMappingService } from '../gim/identity-mapping.service'

/** Metadata key used by @SkipJit() decorator */
export const SKIP_JIT_KEY = 'skipJitProvisioning'

/**
 * Attach to a handler to skip JIT provisioning.
 * Used on public endpoints where req.identity is populated by OptionalIdentityGuard.
 */
export const SkipJit = () =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    Reflect.defineMetadata(SKIP_JIT_KEY, true, descriptor?.value ?? target)
    return descriptor ?? target
  }

// Shape attached to request by ClerkAuthMiddleware — validated here before use
interface RequestWithVerifiedToken {
  verifiedToken?: {
    externalId: string
    email:      string
    role:       'customer' | 'admin'
    jti?:       string
    expiresAt?: string
  }
  identity?: ResolvedIdentity
}

/**
 * SCOPE NOTE — why ModuleRef instead of direct injection:
 *
 * IdentityMappingService is REQUEST scoped (Scope.REQUEST) so that its L1
 * Map<externalId, internalId> cache is isolated per request and carries no
 * global state. NestJS forbids injecting REQUEST-scoped providers directly
 * into SINGLETON consumers — it throws a DependencyException at module init.
 *
 * This guard stays SINGLETON (guards are instantiated once; making them
 * REQUEST-scoped adds per-request allocation overhead). We use
 * ModuleRef.resolve(IdentityMappingService, contextId) to retrieve the
 * existing-or-freshly-created REQUEST instance at canActivate() time.
 *
 * See: https://docs.nestjs.com/fundamentals/module-ref#resolving-scoped-providers
 */
@Injectable()
export class JitProvisioningGuard implements CanActivate {
  private readonly logger = new Logger(JitProvisioningGuard.name)

  constructor(
    private readonly identityService: IIdentityService,  // SINGLETON — safe direct inject
    private readonly moduleRef: ModuleRef,                // for REQUEST-scoped GIM resolution
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Allow handlers decorated with @SkipJit() to bypass
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_JIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (skip) return true

    const req = context.switchToHttp().getRequest<RequestWithVerifiedToken>()

    // ClerkAuthMiddleware MUST have run first and attached verifiedToken.
    // If it's missing the middleware chain is misconfigured — fail hard.
    if (!req.verifiedToken) {
      this.logger.error(
        'JitProvisioningGuard: req.verifiedToken is missing. ' +
        'Ensure ClerkAuthMiddleware runs before this guard in the pipeline.',
      )
      throw new UnauthorizedException({ code: 'AUTH_PIPELINE_MISCONFIGURED' })
    }

    const { externalId, email, role, jti, expiresAt } = req.verifiedToken

    // ── Resolve REQUEST-scoped IdentityMappingService via ModuleRef ──────
    // ContextIdFactory ties this resolution to the current HTTP request so
    // we get the same instance that middleware and decorators use.
    const contextId = ContextIdFactory.getByRequest(req as any)
    this.moduleRef.registerRequestByContextId(req, contextId)
    const gim = await this.moduleRef.resolve(IdentityMappingService, contextId, {
      strict: false,  // allow resolution across module boundaries
    })

    // ── L1/L2 resolution attempt ─────────────────────────────────────────
    let internalId = await gim.resolve(externalId)

    if (!internalId) {
      // ── JIT Provision ──────────────────────────────────────────────────
      this.logger.log(
        `[JIT] No mapping for ${externalId} (${email}). ` +
        `Provisioning user Just-In-Time...`,
      )

      try {
        internalId = await this.identityService.provisionUser({
          externalId,
          email,
          firstName:  this.extractFirstName(email),
          lastName:   '',
          role:       role ?? 'customer',
          source:     'jit_guard',
        })

        this.logger.log(
          `[JIT] Successfully provisioned ${externalId} → ${internalId}`,
        )
      } catch (provisionErr: unknown) {
        const msg = provisionErr instanceof Error ? provisionErr.message : String(provisionErr)
        this.logger.error(`[JIT] Provisioning failed for ${externalId}: ${msg}`)
        throw new UnauthorizedException({
          code:    'JIT_PROVISIONING_FAILED',
          message: 'User account setup is in progress. Please retry in a moment.',
        })
      }
    }

    // ── Hydrate req.identity (the canonical request context object) ──────
    const identity: ResolvedIdentity = ResolvedIdentitySchema.parse({
      internalId,
      externalId,
      email,
      role:       role ?? 'customer',
      sessionCtx: 'clerk_production',
      expiresAt,
      jti,
    })

    req.identity = identity
    return true
  }

  /**
   * Fallback: derive a placeholder firstName from email prefix.
   * The Clerk webhook will overwrite this with the real name once it arrives.
   */
  private extractFirstName(email: string): string {
    const prefix = email.split('@')[0] ?? 'User'
    // Capitalise first letter, replace dots/underscores with space
    return prefix
      .replace(/[._]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 100)
  }
}
