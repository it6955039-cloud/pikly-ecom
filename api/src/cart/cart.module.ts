/**
 * @file cart.module.ts  ← REPLACE src/cart/cart.module.ts
 */
import { Module, forwardRef } from '@nestjs/common'
import { CartService }    from './cart.service'
import { CartController } from './cart.controller'
import { ProductsModule } from '../products/products.module'
import { IdentityModule } from '../identity/identity.module'

@Module({
  imports:     [forwardRef(() => ProductsModule), IdentityModule],
  providers:   [CartService],
  controllers: [CartController],
  exports:     [CartService],
})
export class CartModule {}
