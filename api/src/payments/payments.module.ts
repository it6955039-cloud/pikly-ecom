// src/payments/payments.module.ts
import { Module }                    from '@nestjs/common'
import { PaymentsController }        from './payments.controller'
import { PaymentsService }           from './payments.service'
import { StripeAdapter }             from './adapters/stripe.adapter'
import { IPaymentProvider }          from './ports/payment-provider.port'
import { PaymentStateMachine }       from './state-machine/payment.state-machine'
import { PaymentLedgerService }      from './ledger/payment.ledger.service'
import { PaymentOutboxService }      from './outbox/payment-outbox.service'
import { PaymentOutboxProcessor }    from './outbox/payment-outbox.processor'
import { ReconciliationService }     from './reconciliation.service'
import { MailModule }                from '../mail/mail.module'
import { WebhookModule }             from '../webhooks/webhook.module'
import { IdentityModule }            from '../identity/identity.module'

@Module({
  imports: [MailModule, WebhookModule, IdentityModule],
  providers: [
    PaymentsService,
    PaymentStateMachine,
    PaymentLedgerService,
    PaymentOutboxService,
    PaymentOutboxProcessor,
    ReconciliationService,
    // Provider abstraction — swap StripeAdapter for AdyenAdapter here to change providers
    { provide: IPaymentProvider, useClass: StripeAdapter },
  ],
  controllers: [PaymentsController],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
