// src/admin/admin-bulk.controller.ts — PostgreSQL rewrite, no Mongoose
import { Controller, Post, Body, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger'
import { IsArray, IsString, IsIn, ArrayMinSize, ArrayMaxSize } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { AuthGuard }       from '@nestjs/passport'
import { RolesGuard }      from '../common/guards/roles.guard'
import { Roles }           from '../common/decorators/roles.decorator'
import { ProductsService } from '../products/products.service'
import { DatabaseService } from '../database/database.service'
import { MailService }     from '../mail/mail.service'
import { WebhookService }  from '../webhooks/webhook.service'
import { successResponse } from '../common/api-utils'

// Runs up to `concurrency` promises simultaneously — limits PG pool usage
function withConcurrency<T>(
  items: T[], concurrency: number, fn: (item: T, i: number) => Promise<any>,
): Promise<any[]> {
  let index = 0
  const results: any[] = new Array(items.length)
  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i], i)
    }
  }
  return Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  ).then(() => results)
}

class BulkProductActionDto {
  @ApiProperty({ type: [String] })
  @IsArray() @IsString({ each: true })
  @ArrayMinSize(1) @ArrayMaxSize(100)
  ids: string[]

  @ApiProperty({ enum: ['activate','deactivate','delete'] })
  @IsIn(['activate','deactivate','delete'])
  action: string
}

class BulkOrderActionDto {
  @ApiProperty({ type: [String] })
  @IsArray() @IsString({ each: true })
  @ArrayMinSize(1) @ArrayMaxSize(100)
  orderIds: string[]

  @ApiProperty({ enum: ['confirm','cancel','mark_shipped','mark_delivered'] })
  @IsIn(['confirm','cancel','mark_shipped','mark_delivered'])
  action: string
}

@ApiTags('Admin — Bulk Operations')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/bulk')
export class AdminBulkController {
  constructor(
    private readonly products:  ProductsService,
    private readonly db:        DatabaseService,
    private readonly mail:      MailService,
    private readonly webhooks:  WebhookService,
  ) {}

  @Post('products')
  @ApiOperation({ summary: '[Admin] Bulk product action: activate / deactivate / delete (max 100)' })
  async bulkProducts(@Body() dto: BulkProductActionDto) {
    const results = await withConcurrency(dto.ids, 10, async (id) => {
      try {
        if (dto.action === 'activate')   await this.products.adminUpdate(id, { is_active: true })
        if (dto.action === 'deactivate') await this.products.adminUpdate(id, { is_active: false })
        if (dto.action === 'delete')     await this.products.adminDelete(id)
        return { id, success: true }
      } catch (err: any) {
        return { id, success: false, error: err.message }
      }
    })

    const succeeded = results.filter(r => r.success).length
    return successResponse({ results, succeeded, failed: results.length - succeeded })
  }

  @Post('orders')
  @ApiOperation({ summary: '[Admin] Bulk order status update (max 100)' })
  async bulkOrders(@Body() dto: BulkOrderActionDto) {
    const statusMap: Record<string, string> = {
      confirm:        'confirmed',
      cancel:         'cancelled',
      mark_shipped:   'shipped',
      mark_delivered: 'delivered',
    }
    const newStatus = statusMap[dto.action]

    const results = await withConcurrency(dto.orderIds, 10, async (orderId) => {
      try {
        const order = await this.db.queryOne<any>(
          'SELECT * FROM store.orders WHERE order_id = $1', [orderId],
        )
        if (!order) return { orderId, success: false, error: 'Not found' }

        const prevStatus = order.status
        const timeline   = [
          ...(order.timeline ?? []),
          {
            status: newStatus, timestamp: new Date(),
            note: `Bulk updated to ${newStatus} by admin`,
          },
        ]

        // Payment status for terminal states
        let paymentStatus = order.payment_status
        if (newStatus === 'cancelled') {
          paymentStatus = order.payment_method === 'cod' ? 'cancelled' : 'pending_refund'
        }
        if (newStatus === 'delivered') paymentStatus = 'paid'

        await this.db.execute(
          `UPDATE store.orders
           SET status = $1, timeline = $2, payment_status = $3, updated_at = NOW()
           WHERE order_id = $4`,
          [newStatus, JSON.stringify(timeline), paymentStatus, orderId],
        )

        // Loyalty points on delivery
        if (newStatus === 'delivered') {
          const pts = Math.floor(order.pricing?.total ?? 0)
          if (pts > 0) {
            await this.db.execute(
              'UPDATE store.users SET loyalty_points = loyalty_points + $1 WHERE id = $2',
              [pts, order.user_id],
            ).catch(() => void 0)
          }
        }

        // Shipping email — only once
        if (newStatus === 'shipped' && prevStatus !== 'shipped' && !order.shipping_email_sent) {
          const user = await this.db.queryOne<any>(
            'SELECT email, first_name FROM store.users WHERE id = $1', [order.user_id],
          )
          if (user) {
            this.mail.sendShippingNotification(user.email, user.first_name, order).catch(() => void 0)
            await this.db.execute(
              'UPDATE store.orders SET shipping_email_sent = true WHERE order_id = $1', [orderId],
            ).catch(() => void 0)
          }
        }

        // Webhooks
        this.webhooks.dispatch('order.status_changed', { orderId, previousStatus: prevStatus, newStatus }).catch(() => void 0)
        if (newStatus === 'shipped')   this.webhooks.dispatch('order.shipped',   { orderId }).catch(() => void 0)
        if (newStatus === 'delivered') this.webhooks.dispatch('order.delivered', { orderId }).catch(() => void 0)
        if (newStatus === 'cancelled') this.webhooks.dispatch('order.cancelled', { orderId }).catch(() => void 0)

        return { orderId, success: true, newStatus }
      } catch (err: any) {
        return { orderId, success: false, error: err.message }
      }
    })

    const succeeded = results.filter(r => r.success).length
    return successResponse({ results, succeeded, failed: results.length - succeeded })
  }
}
