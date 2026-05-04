/**
 * @file recently-viewed.module.ts  ← REPLACE src/recently-viewed/recently-viewed.module.ts
 */
import { Module }                    from '@nestjs/common'
import { RecentlyViewedController }  from './recently-viewed.controller'
import { RecentlyViewedService }     from './recently-viewed.service'
import { ProductsModule }            from '../products/products.module'
import { IdentityModule }            from '../identity/identity.module'

@Module({
  imports:     [ProductsModule, IdentityModule],
  controllers: [RecentlyViewedController],
  providers:   [RecentlyViewedService],
})
export class RecentlyViewedModule {}
