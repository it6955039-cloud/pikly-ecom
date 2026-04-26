// src/homepage/homepage.module.ts
//
// FIX-7: DatabaseModule, CacheModule, RedisModule are all @Global() — already
// available everywhere. No need to import them here. Removed.
//
// FIX-8: HomepageWidgetsService is not needed by any v2 service.
// It remains registered because HomepageService (v1) depends on it internally.
// It is NOT exported because nothing outside this module uses it.

import { Module } from '@nestjs/common'
import { HomepageController } from './homepage.controller'
import { HomepageService } from './homepage.service'
import { HomepageStorefrontService } from './homepage-storefront.service'
import { HomepageStorefrontV2Service } from './homepage-storefront-v2.service'
import { HomepageWidgetsService } from './homepage-widgets.service'
import { PersonalizationService } from './homepage-personalization.service'
import { PersonalizationV2Service } from './homepage-personalization-v2.service'
import { ProductsModule } from '../products/products.module'
import { CategoriesModule } from '../categories/categories.module'

@Module({
  imports: [
    ProductsModule, // provides ProductsService + findProductByAsin
    CategoriesModule, // provides CategoriesService.categories[]
    // DatabaseModule, CacheModule, RedisModule are @Global() — no import needed
  ],
  controllers: [HomepageController],
  providers: [
    // ── v1 (keep until deprecated routes removed — target: 2025-09-01) ──────
    HomepageService,
    HomepageStorefrontService,
    HomepageWidgetsService,
    PersonalizationService,

    // ── v2 ──────────────────────────────────────────────────────────────────
    HomepageStorefrontV2Service,
    PersonalizationV2Service,
  ],
  exports: [
    // Exported for admin cache invalidation endpoint
    HomepageStorefrontV2Service,
    PersonalizationV2Service,
    // v1 exports kept for backward compat
    HomepageService,
    HomepageStorefrontService,
    PersonalizationService,
  ],
})
export class HomepageModule {}
