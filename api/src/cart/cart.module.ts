import { Module, forwardRef } from '@nestjs/common'
import { CartService }    from './cart.service'
import { CartController } from './cart.controller'
import { ProductsModule } from '../products/products.module'

@Module({
  imports:     [forwardRef(() => ProductsModule)],
  providers:   [CartService],
  controllers: [CartController],
  exports:     [CartService],
})
export class CartModule {}
