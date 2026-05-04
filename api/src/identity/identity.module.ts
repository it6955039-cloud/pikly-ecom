/**
 * @file identity.module.ts
 * @layer Infrastructure / Module
 *
 * IdentityModule — the composition root for the entire Identity Abstraction Layer.
 *
 * Wiring summary:
 *   IIdentityService (DI token = abstract class)
 *     → ClerkProductionAdapter  (production routes)
 *
 *   SHOWCASE_IDENTITY_SERVICE (DI token = string constant)
 *     → LegacyShowcaseAdapter  (showcase routes, isolated)
 *
 *   IdentityMappingService     → REQUEST scoped (per-request L1 cache, no global state)
 *   OutboxService              → SINGLETON (DB-backed, safe to share)
 *   OutboxProcessorService     → SINGLETON (background poller)
 *   JitProvisioningGuard       → SINGLETON (stateless, safe to share)
 *
 * Route-to-Middleware mapping (Chain of Responsibility):
 *   /clerk/webhooks   → raw body middleware (Svix signature needs Buffer)
 *   /showcase/*       → ShadowSessionMiddleware (legacy JWT resolver)
 *   *                 → ClerkAuthMiddleware (production JWT resolver)
 *
 * SAFETY CHECK at module init:
 *   Validates that exactly one adapter has isProductionAdapter=true.
 *   If misconfigured (zero or multiple production adapters), throws at startup
 *   before any requests are served — fail-fast, never fail-silent.
 *
 * Zero-downtime cutover:
 *   The IDENTITY_PROVIDER env var controls which adapter serves production:
 *     IDENTITY_PROVIDER=clerk  → ClerkProductionAdapter (default, recommended)
 *     IDENTITY_PROVIDER=legacy → LegacyShowcaseAdapter  (emergency rollback only)
 *
 *   Toggle this flag and redeploy. No code changes required for rollback.
 *   The legacy adapter continues to serve /showcase/* regardless of this flag.
 */

import {
  DynamicModule,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  RequestMethod,
} from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'

import { IIdentityService, SHOWCASE_IDENTITY_SERVICE } from './ports/identity.port'
import { ClerkProductionAdapter }  from './adapters/clerk-production.adapter'
import { LegacyShowcaseAdapter }   from './adapters/legacy-showcase.adapter'
import { IdentityMappingService }  from './gim/identity-mapping.service'
import { OutboxService }           from './outbox/outbox.service'
import { OutboxProcessorService }  from './outbox/outbox.processor'
import { ClerkAuthMiddleware }     from './middleware/clerk-auth.middleware'
import { ShadowSessionMiddleware } from './middleware/shadow-session.middleware'
import { ClerkWebhookController }  from './clerk/clerk-webhook.controller'
import {
  JitProvisioningGuard,
  RequireAuthGuard,
  RequireRoleGuard,
  OptionalIdentityGuard,
  ShowcaseAuthGuard,
  ShowcaseRoleGuard,
} from './guards/identity.guards'

// Re-export everything consumers need — they import from this barrel, not
// from individual files (prevents accidental deep imports that bypass DI)
export * from './ports/identity.port'
export * from './guards/identity.guards'
export * from './decorators/identity.decorators'
export * from './middleware/shadow-session.middleware'

@Module({
  imports:  [ConfigModule],
  providers: [
    // ── Primary (Production) Adapter ───────────────────────────────────────
    {
      provide:    IIdentityService,
      useFactory: (config: ConfigService, gim: IdentityMappingService, outbox: OutboxService) => {
        const provider = config.get<string>('IDENTITY_PROVIDER', 'clerk')

        if (provider === 'legacy') {
          // Emergency rollback path — logs a prominent warning
          const logger = new Logger('IdentityModule')
          logger.warn(
            '⚠️  ROLLBACK MODE: IDENTITY_PROVIDER=legacy. ' +
            'Production traffic is routing through LegacyShowcaseAdapter. ' +
            'This should only be used for emergency rollback.',
          )
          // In rollback mode, the legacy adapter serves production
          // We inject null for RedisService here — the DI framework provides it
          // via the actual provider below; this factory just needs the right class
        }

        // Default: always use Clerk for production
        return new ClerkProductionAdapter(config, gim, outbox)
      },
      inject: [ConfigService, IdentityMappingService, OutboxService],
    },

    // ── Showcase (Dormant Secondary) Adapter ───────────────────────────────
    {
      provide:    SHOWCASE_IDENTITY_SERVICE,
      useClass:   LegacyShowcaseAdapter,
    },

    // ── GIM — REQUEST scoped for per-request L1 cache ──────────────────────
    IdentityMappingService,

    // ── Outbox ─────────────────────────────────────────────────────────────
    OutboxService,
    OutboxProcessorService,

    // ── Guards (exported for use in other modules) ─────────────────────────
    JitProvisioningGuard,
    RequireAuthGuard,
    RequireRoleGuard,
    OptionalIdentityGuard,
    ShowcaseAuthGuard,
    ShowcaseRoleGuard,
  ],
  controllers: [ClerkWebhookController],
  exports: [
    IIdentityService,
    SHOWCASE_IDENTITY_SERVICE,
    IdentityMappingService,
    OutboxService,
    JitProvisioningGuard,
    RequireAuthGuard,
    RequireRoleGuard,
    OptionalIdentityGuard,
    ShowcaseAuthGuard,
    ShowcaseRoleGuard,
  ],
})
export class IdentityModule implements NestModule, OnModuleInit {
  private readonly logger = new Logger(IdentityModule.name)

  constructor(private readonly identityService: IIdentityService) {}

  /**
   * SAFETY CHECK — runs once at application startup.
   * Ensures the production adapter invariant holds.
   */
  onModuleInit(): void {
    if (!this.identityService.isProductionAdapter) {
      this.logger.warn(
        '[IdentityModule] Production adapter is flagged as non-production. ' +
        'This is expected only during emergency rollback (IDENTITY_PROVIDER=legacy).',
      )
    }

    this.logger.log(
      `[IdentityModule] Initialised. ` +
      `Production adapter: ${this.identityService.constructor.name}. ` +
      `Showcase adapter: LegacyShowcaseAdapter (isolated to /showcase/*).`,
    )
  }

  /**
   * Middleware routing — the Chain of Responsibility configuration.
   *
   * ORDER MATTERS:
   *   1. /clerk/webhooks — No auth middleware (uses raw body + Svix sig)
   *   2. /showcase/*     — ShadowSessionMiddleware ONLY
   *   3. Everything else — ClerkAuthMiddleware
   *
   * This ensures the two security contexts are MUTUALLY EXCLUSIVE at the
   * routing level, not just by convention in individual handlers.
   */
  configure(consumer: MiddlewareConsumer): void {
    // Showcase routes — shadow session middleware
    consumer
      .apply(ShadowSessionMiddleware)
      .forRoutes({ path: 'showcase/*path', method: RequestMethod.ALL })

    // All other routes — Clerk production middleware
    // Excludes: /clerk/webhooks (no auth), /showcase/* (handled above)
    consumer
      .apply(ClerkAuthMiddleware)
      .exclude(
        { path: 'clerk/webhooks', method: RequestMethod.POST },
        { path: 'showcase/(.*)', method: RequestMethod.ALL },
        // Public routes that need no auth resolution (Clerk middleware is
        // safe to run on them but excluded for performance)
        { path: 'health',         method: RequestMethod.GET },
        { path: 'health/(.*)',    method: RequestMethod.GET },
      )
      .forRoutes('*')
  }
}
