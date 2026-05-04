/**
 * @file wishlist.module.ts  ← REPLACE src/wishlist/wishlist.module.ts
 */
import { Module }           from '@nestjs/common'
import { WishlistController } from './wishlist.controller'
import { WishlistService }  from './wishlist.service'
import { ProductsModule }   from '../products/products.module'
import { IdentityModule }   from '../identity/identity.module'

@Module({
  imports:     [ProductsModule, IdentityModule],
  controllers: [WishlistController],
  providers:   [WishlistService],
  exports:     [WishlistService],
})
export class WishlistModule {}
