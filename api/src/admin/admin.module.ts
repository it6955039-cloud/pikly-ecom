// src/admin/admin.module.ts
//
// DatabaseModule is @Global (registered in AppModule) — DatabaseService can be
// injected into any controller/service without importing DatabaseModule here.
// AdminCategoriesController and AdminProductsController both inject DatabaseService
// for direct DB queries (bypass stale in-memory arrays for admin operations).

import { Module }                          from '@nestjs/common'
import { AdminOrdersController }           from './admin-orders.controller'
import { AdminUsersController }            from './admin-users.controller'
import { AdminCouponsController }          from './admin-coupons.controller'
import { AdminBannersController }          from './admin-banners.controller'
import { AdminProductsController }         from './admin-products.controller'
import { AdminCategoriesController }       from './admin-categories.controller'
import { AdminAnalyticsController }        from './admin-analytics.controller'
import { AdminBulkController }             from './admin-bulk.controller'
import { AdminHomepageWidgetsController }  from './admin-homepage-widgets.controller'
import { ProductsModule }                  from '../products/products.module'
import { CategoriesModule }                from '../categories/categories.module'
import { HomepageModule }                  from '../homepage/homepage.module'
import { WebhookModule }                   from '../webhooks/webhook.module'
import { IdentityModule }                  from '../identity/identity.module'

@Module({
  imports: [
    ProductsModule,
    CategoriesModule,
    HomepageModule,
    WebhookModule,
    IdentityModule,   // provides RequireRoleGuard, JitProvisioningGuard, @RequireRole
    // DatabaseModule is NOT listed here — it is @Global() and available everywhere.
  ],
  controllers: [
    AdminOrdersController,
    AdminUsersController,
    AdminCouponsController,
    AdminBannersController,
    AdminProductsController,
    AdminCategoriesController,
    AdminAnalyticsController,
    AdminBulkController,
    AdminHomepageWidgetsController,
  ],
})
export class AdminModule {}
