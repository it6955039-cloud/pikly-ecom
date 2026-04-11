import { Module } from '@nestjs/common'
import { WishlistController } from './wishlist.controller'
import { WishlistService } from './wishlist.service'
import { ProductsModule } from '../products/products.module'

@Module({
  imports:     [ProductsModule],
  controllers: [WishlistController],
  providers:   [WishlistService],
  exports:     [WishlistService],
})
export class WishlistModule {}
