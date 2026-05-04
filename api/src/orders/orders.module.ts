/**
 * @file orders.module.ts  ← REPLACE src/orders/orders.module.ts
 * Change: add IdentityModule to imports
 */
import { Module, forwardRef } from '@nestjs/common'
import { OrdersService }      from './orders.service'
import { OrdersController }   from './orders.controller'
import { CartModule }         from '../cart/cart.module'
import { ProductsModule }     from '../products/products.module'
import { WebhookModule }      from '../webhooks/webhook.module'
import { MailModule }         from '../mail/mail.module'
import { IdentityModule }     from '../identity/identity.module'

@Module({
  imports: [
    forwardRef(() => CartModule),
    forwardRef(() => ProductsModule),
    WebhookModule,
    MailModule,
    IdentityModule,   // ← provides RequireAuthGuard, JitProvisioningGuard
  ],
  providers:   [OrdersService],
  controllers: [OrdersController],
  exports:     [OrdersService],
})
export class OrdersModule {}
