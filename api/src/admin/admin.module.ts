// src/admin/admin.module.ts — no Mongoose, no MongooseModule
import { Module }                     from '@nestjs/common'
import { AdminOrdersController }      from './admin-orders.controller'
import { AdminUsersController }       from './admin-users.controller'
import { AdminCouponsController }     from './admin-coupons.controller'
import { AdminBannersController }     from './admin-banners.controller'
import { AdminProductsController }    from './admin-products.controller'
import { AdminCategoriesController }  from './admin-categories.controller'
import { AdminAnalyticsController }   from './admin-analytics.controller'
import { AdminBulkController }        from './admin-bulk.controller'
import { ProductsModule }             from '../products/products.module'
import { CategoriesModule }           from '../categories/categories.module'
import { HomepageModule }             from '../homepage/homepage.module'
import { WebhookModule }              from '../webhooks/webhook.module'

@Module({
  imports: [
    ProductsModule,
    CategoriesModule,
    HomepageModule,
    WebhookModule,
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
  ],
})
export class AdminModule {}
