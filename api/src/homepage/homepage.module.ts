// src/homepage/homepage.module.ts  ← REPLACE
//
// CHANGES vs v2 original:
//   1. Added IdentityModule — provides RequireAuthGuard, JitProvisioningGuard,
//      OptionalIdentityGuard for the controller's guard chain.
//   2. All other providers/exports unchanged from v2.
//
// Note: DatabaseModule, CacheModule, RedisModule are @Global() — no import needed here.

import { Module } from '@nestjs/common'
import { HomepageController }             from './homepage.controller'
import { HomepageService }                from './homepage.service'
import { HomepageStorefrontService }      from './homepage-storefront.service'
import { HomepageStorefrontV2Service }    from './homepage-storefront-v2.service'
import { HomepageWidgetsService }         from './homepage-widgets.service'
import { PersonalizationService }         from './homepage-personalization.service'
import { PersonalizationV2Service }       from './homepage-personalization-v2.service'
import { ProductsModule }                 from '../products/products.module'
import { CategoriesModule }               from '../categories/categories.module'
import { IdentityModule }                 from '../identity/identity.module'

@Module({
  imports: [
    ProductsModule,
    CategoriesModule,
    IdentityModule,   // ← provides OptionalIdentityGuard, RequireAuthGuard, JitProvisioningGuard
  ],
  controllers: [HomepageController],
  providers: [
    // v1 — kept until deprecated routes removed (target: 2025-09-01)
    HomepageService,
    HomepageStorefrontService,
    HomepageWidgetsService,
    PersonalizationService,
    // v2
    HomepageStorefrontV2Service,
    PersonalizationV2Service,
  ],
  exports: [
    HomepageStorefrontV2Service,
    PersonalizationV2Service,
    // v1 exports kept for backward compat (admin cache invalidation)
    HomepageService,
    HomepageStorefrontService,
    PersonalizationService,
  ],
})
export class HomepageModule {}
