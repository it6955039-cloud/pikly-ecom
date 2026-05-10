// src/payments/payments.controller.ts
//
// Two endpoints — completely different auth requirements:
//
//   POST /payments/checkout-session  → auth required (JIT guard chain)
//   POST /payments/stripe/webhook    → NO auth, raw body, Stripe signature verified in service

import {
  Controller, Post, Body, Req, Headers,
  UseGuards, HttpCode, HttpStatus, BadRequestException, Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBody, ApiBearerAuth, ApiExcludeEndpoint } from '@nestjs/swagger'
import { Request } from 'express'
import { RawBodyRequest } from '@nestjs/common'

import { PaymentsService }       from './payments.service'
import { CreateCheckoutSessionDto } from './dto/payment.dto'
import { successResponse }       from '../common/api-utils'
import { RequireAuthGuard }      from '../identity/guards/identity.guards'
import { JitProvisioningGuard }  from '../identity/jit/jit-provisioning.guard'
import { CurrentUserId }         from '../identity/decorators/identity.decorators'

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name)

  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * POST /api/payments/checkout-session
   *
   * Creates a Stripe Checkout Session for an existing pending card order.
   * Returns the hosted checkout URL — frontend redirects the user there.
   *
   * Auth required: Clerk Bearer JWT.
   */
  @Post('checkout-session')
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create Stripe Checkout Session for a pending order',
    description:
      'Creates a hosted Stripe payment page for the given order. ' +
      'Redirect the user to the returned `url`. ' +
      'Order must be in `pending` status with `payment_method: "card"`. ' +
      'Amount is always recalculated server-side — frontend values are ignored.',
  })
  @ApiBody({ type: CreateCheckoutSessionDto })
  async createCheckoutSession(
    @CurrentUserId() userId: string,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    const session = await this.paymentsService.createCheckoutSession(userId, dto.orderId)
    return successResponse(session)
  }

  /**
   * POST /api/payments/stripe/webhook
   *
   * Receives Stripe webhook events.
   *
   * This endpoint is EXCLUDED from:
   *   - Clerk authentication middleware (identity.module.ts exclusion list)
   *   - ValidationPipe body transformation (raw body is needed for signature verification)
   *
   * rawBody is preserved by NestJS bootstrap rawBody: true flag (already set in main.ts).
   * Signature is verified by StripeAdapter.constructWebhookEvent() before any processing.
   *
   * Always returns 200 after signature verification to prevent Stripe from retrying.
   * Internal processing errors are logged and stored — not surfaced as HTTP errors.
   */
  @Post('stripe/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()  // Hide from Swagger — not a client-facing endpoint
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const rawBody = req.rawBody
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      this.logger.error('[stripe/webhook] rawBody missing — check NestJS bootstrap rawBody:true')
      throw new BadRequestException({ code: 'MISSING_RAW_BODY' })
    }

    if (!signature) {
      this.logger.warn('[stripe/webhook] Missing stripe-signature header')
      throw new BadRequestException({ code: 'MISSING_STRIPE_SIGNATURE' })
    }

    // Service handles signature verification, deduplication, and processing.
    // Throws BadRequestException only on signature failure (before any processing).
    // All other errors are caught internally — webhook always receives 200.
    await this.paymentsService.handleInboundWebhook(rawBody, signature)
    return { received: true }
  }
}
