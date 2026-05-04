/**
 * @file app.module.ts  ← REPLACE src/app.module.ts
 *
 * AppModule — updated for Clerk IdP migration.
 *
 * CHANGES vs original:
 *   REMOVED:
 *     - AuthModule        (replaced by IdentityModule)
 *     - PassportModule    (no longer needed — jose handles JWKS verification)
 *
 *   ADDED:
 *     - IdentityModule    (IAL: Ports & Adapters, GIM, JIT, Outbox, Middleware chain)
 *     - ShowcaseModule    (dormant legacy demo under /showcase/*)
 *
 *   UNCHANGED:
 *     Everything else — all domain modules are auth-agnostic and require zero changes.
 *
 * Note: AuthModule is NOT deleted — it becomes part of ShowcaseModule's
 * internal wiring for the legacy JWT engine. It is no longer imported here.
 */

import { Module }            from '@nestjs/common'
import { APP_GUARD }         from '@nestjs/core'
import { ConfigModule }      from '@nestjs/config'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'

// Infrastructure
import { DatabaseModule }          from './database/database.module'
import { RedisModule }             from './redis/redis.module'
import { MailModule }              from './mail/mail.module'
import { CacheModule }             from './common/cache.module'
import { AlgoliaModule }           from './algolia/algolia.module'

// ✅  NEW: Identity Abstraction Layer (replaces AuthModule)
import { IdentityModule }          from './identity/identity.module'
// ✅  NEW: Dormant Legacy Showcase
import { ShowcaseModule }          from './showcase/showcase.module'

// Domain modules — all UNCHANGED
import { CatalogIntelligenceModule } from './catalog-intelligence/cil.module'
import { UsersModule }             from './users/users.module'
import { ProductsModule }          from './products/products.module'
import { CategoriesModule }        from './categories/categories.module'
import { DepartmentsModule }       from './departments/departments.module'
import { CartModule }              from './cart/cart.module'
import { WishlistModule }          from './wishlist/wishlist.module'
import { OrdersModule }            from './orders/orders.module'
import { HomepageModule }          from './homepage/homepage.module'
import { ImagesModule }            from './images/images.module'
import { CompareModule }           from './compare/compare.module'
import { CouponsModule }           from './coupons/coupons.module'
import { RecentlyViewedModule }    from './recently-viewed/recently-viewed.module'
import { HealthModule }            from './health/health.module'
import { CategoryShowcaseModule }  from './category-showcase/category-showcase.module'
import { AdminModule }             from './admin/admin.module'
import { WebhookModule }           from './webhooks/webhook.module'
import { UploadsModule }           from './uploads/uploads.module'

@Module({
  imports: [
    // ── Global config ────────────────────────────────────────────────────────
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    // ── Infrastructure ───────────────────────────────────────────────────────
    DatabaseModule,          // @Global — Neon PostgreSQL
    RedisModule,
    MailModule,
    CacheModule,
    AlgoliaModule,

    // ── Identity (replaces AuthModule) ───────────────────────────────────────
    IdentityModule,          // ClerkProductionAdapter + GIM + JIT + Outbox + Middleware
    ShowcaseModule,          // LegacyShowcaseAdapter + /showcase/* routes

    // ── Domain modules (ZERO changes required) ───────────────────────────────
    CatalogIntelligenceModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    DepartmentsModule,
    CartModule,
    WishlistModule,
    OrdersModule,
    HomepageModule,
    ImagesModule,
    CompareModule,
    CouponsModule,
    RecentlyViewedModule,
    HealthModule,
    CategoryShowcaseModule,
    AdminModule,
    WebhookModule,
    UploadsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
