/**
 * @file cart.module.ts
 *
 * FIX: OptionalJitGuard providers mein add kiya.
 * Yeh guard cart controller pe laga hai — iske bina NestJS
 * dependency injection fail karta aur server start nahi hota.
 */
import { Module, forwardRef } from '@nestjs/common'
import { CartService } from './cart.service'
import { CartController } from './cart.controller'
import { OptionalJitGuard } from '../identity/guards/optional-jit.guard' 
import { ProductsModule } from '../products/products.module'
import { IdentityModule } from '../identity/identity.module'

@Module({
  imports: [forwardRef(() => ProductsModule), IdentityModule],
  providers: [CartService, OptionalJitGuard], // ← OptionalJitGuard add kiya
  controllers: [CartController],
  exports: [CartService],
})
export class CartModule {}
