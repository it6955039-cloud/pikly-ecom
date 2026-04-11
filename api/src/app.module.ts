// src/app.module.ts — PostgreSQL backend (no MongoDB)  v5.0.0
import { Module }            from '@nestjs/common'
import { APP_GUARD }         from '@nestjs/core'
import { ConfigModule }      from '@nestjs/config'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { DatabaseModule }    from './database/database.module'
import { RedisModule }       from './redis/redis.module'
import { MailModule }        from './mail/mail.module'
import { CacheModule }       from './common/cache.module'
import { AlgoliaModule }     from './algolia/algolia.module'
import { CatalogIntelligenceModule } from './catalog-intelligence/cil.module'
import { AuthModule }            from './auth/auth.module'
import { UsersModule }           from './users/users.module'
import { ProductsModule }        from './products/products.module'
import { CategoriesModule }      from './categories/categories.module'
import { DepartmentsModule }     from './departments/departments.module'
import { CartModule }            from './cart/cart.module'
import { WishlistModule }        from './wishlist/wishlist.module'
import { OrdersModule }          from './orders/orders.module'
import { HomepageModule }        from './homepage/homepage.module'
import { ImagesModule }          from './images/images.module'
import { CompareModule }         from './compare/compare.module'
import { CouponsModule }         from './coupons/coupons.module'
import { RecentlyViewedModule }  from './recently-viewed/recently-viewed.module'
import { HealthModule }          from './health/health.module'
import { CategoryShowcaseModule } from './category-showcase/category-showcase.module'
import { AdminModule }           from './admin/admin.module'
import { WebhookModule }         from './webhooks/webhook.module'
import { UploadsModule }         from './uploads/uploads.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,     // @Global — Neon PostgreSQL for all modules
    RedisModule,
    MailModule,
    CacheModule,
    AlgoliaModule,
    CatalogIntelligenceModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    DepartmentsModule,  // ← NEW: departments derived from store.products
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
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
