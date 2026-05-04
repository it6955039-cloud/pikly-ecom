// src/admin/admin.module.ts  ← REPLACE
//
// CHANGES vs v2 original:
//   1. Added AdminHomepageWidgetsController (new in v2)
//   2. Added IdentityModule — provides RequireRoleGuard, JitProvisioningGuard,
//      @RequireRole for all admin controllers

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
    IdentityModule,   // ← provides RequireRoleGuard, JitProvisioningGuard, @RequireRole
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
    AdminHomepageWidgetsController,   // ← new in v2
  ],
})
export class AdminModule {}
