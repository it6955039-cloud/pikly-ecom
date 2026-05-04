/**
 * @file webhooks/webhook.module.ts  ← REPLACE src/webhooks/webhook.module.ts
 *
 * Change: add IdentityModule to imports so WebhookController's
 * RequireRoleGuard + JitProvisioningGuard can be resolved by the DI container.
 */
import { Module }            from '@nestjs/common'
import { WebhookController } from './webhook.controller'
import { WebhookService }    from './webhook.service'
import { IdentityModule }    from '../identity/identity.module'

@Module({
  imports:     [IdentityModule],
  controllers: [WebhookController],
  providers:   [WebhookService],
  exports:     [WebhookService],
})
export class WebhookModule {}
