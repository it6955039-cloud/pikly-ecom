// src/admin/admin-orders.controller.ts  ← REPLACE
// DIFF: AuthGuard('jwt') + RolesGuard + @Roles → RequireRoleGuard + JIT + @RequireRole
// All handler bodies are IDENTICAL to the original.
import {
  Controller, Get, Patch, Param, Query, Body,
  UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery, ApiProperty } from '@nestjs/swagger'
import {
  IsIn, IsString, IsOptional, MaxLength,
} from 'class-validator'
import { DatabaseService } from '../database/database.service'
import { MailService }     from '../mail/mail.service'
import { WebhookService }  from '../webhooks/webhook.service'
import { successResponse } from '../common/api-utils'
// ✅ NEW — replaces AuthGuard('jwt') + RolesGuard + @Roles
import { RequireRoleGuard }   from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }        from '../identity/guards/identity.guards'

const VALID_STATUSES = ['pending','confirmed','processing','shipped','delivered','cancelled'] as const
type OrderStatus = typeof VALID_STATUSES[number]

class UpdateOrderStatusDto {
  @ApiProperty({ enum: VALID_STATUSES })
  @IsIn(VALID_STATUSES, { message: `status must be one of: ${VALID_STATUSES.join(', ')}` })
  status: OrderStatus

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500)
  message?: string
}

class AddTrackingDto {
  @ApiProperty()
  @IsString() @MaxLength(200)
  trackingNumber: string

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(50)
  estimatedDelivery?: string
}

@ApiTags('Admin — Orders')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly db:       DatabaseService,
    private readonly mail:     MailService,
    private readonly webhooks: WebhookService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: '[Admin] Order counts by status' })
  async stats() {
    const rows = await this.db.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM store.orders GROUP BY status ORDER BY count DESC`,
    )
    const stats: Record<string, number> = {}
    let total = 0
    for (const r of rows) { stats[r.status] = r.count; total += r.count }
    return successResponse({ ...stats, total })
  }

  @Get()
  @ApiOperation({ summary: '[Admin] List all orders with filters and pagination' })
  @ApiQuery({ name: 'page',   required: false })
  @ApiQuery({ name: 'limit',  required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findAll(
    @Query('page')   page?:   string,
    @Query('limit')  limit?:  string,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, Number(page ?? 1))
    const l = Math.min(100, Math.max(1, Number(limit ?? 20)))
    const offset = (p - 1) * l
    const conditions: string[] = []
    const params: any[] = []
    let idx = 1

    if (status) { conditions.push(`o.status = $${idx++}`);  params.push(status) }
    if (userId) { conditions.push(`o.user_id = $${idx++}`); params.push(userId) }
    if (search && search.length <= 100) {
      conditions.push(`o.order_id ILIKE $${idx++}`)
      params.push(`%${search.replace(/[%_\\]/g, '\\$&')}%`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [rows, ct] = await Promise.all([
      this.db.query<any>(
        `SELECT o.*, u.email AS user_email, u.first_name AS user_first_name
         FROM store.orders o
         LEFT JOIN store.users u ON u.id = o.user_id
         ${where}
         ORDER BY o.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, l, offset],
      ),
      this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM store.orders o ${where}`, params,
      ),
    ])

    return successResponse({
      orders: rows,
      pagination: {
        total:       ct?.cnt ?? 0,
        page:        p,
        limit:       l,
        totalPages:  Math.ceil((ct?.cnt ?? 0) / l),
        hasNextPage: p * l < (ct?.cnt ?? 0),
      },
    })
  }

  @Get(':orderId')
  @ApiOperation({ summary: '[Admin] Single order detail' })
  @ApiParam({ name: 'orderId' })
  async findOne(@Param('orderId') orderId: string) {
    const order = await this.db.queryOne<any>(
      `SELECT o.*, u.email AS user_email, u.first_name AS user_first_name
       FROM store.orders o
       LEFT JOIN store.users u ON u.id = o.user_id
       WHERE o.order_id = $1`,
      [orderId],
    )
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })
    return successResponse(order)
  }

  @Patch(':orderId/status')
  @ApiOperation({ summary: '[Admin] Update order status' })
  @ApiParam({ name: 'orderId' })
  async updateStatus(
    @Param('orderId') orderId: string,
    @Body() body: UpdateOrderStatusDto,
  ) {
    const order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE order_id = $1', [orderId],
    )
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })

    const prevStatus = order.status
    const timeline   = [
      ...(order.timeline ?? []),
      { status: body.status, timestamp: new Date(), note: body.message ?? `Updated to ${body.status} by admin` },
    ]

    let paymentStatus = order.payment_status
    if (body.status === 'cancelled') paymentStatus = order.payment_method === 'cod' ? 'cancelled' : 'pending_refund'
    if (body.status === 'delivered') paymentStatus = 'paid'

    const updated = await this.db.queryOne<any>(
      `UPDATE store.orders SET status=$1, timeline=$2, payment_status=$3, updated_at=NOW()
       WHERE order_id=$4 RETURNING *`,
      [body.status, JSON.stringify(timeline), paymentStatus, orderId],
    )

    if (body.status === 'delivered') {
      const pts = Math.floor(order.pricing?.total ?? 0)
      if (pts > 0) {
        await this.db.execute(
          'UPDATE store.users SET loyalty_points=loyalty_points+$1 WHERE id=$2',
          [pts, order.user_id],
        ).catch(() => void 0)
      }
    }

    if (body.status === 'shipped' && prevStatus !== 'shipped' && !order.shipping_email_sent) {
      const user = await this.db.queryOne<any>(
        'SELECT email, first_name FROM store.users WHERE id=$1', [order.user_id],
      )
      if (user) {
        this.mail.sendShippingNotification(user.email, user.first_name, updated).catch(() => void 0)
        await this.db.execute(
          'UPDATE store.orders SET shipping_email_sent=true WHERE order_id=$1', [orderId],
        ).catch(() => void 0)
      }
    }

    this.webhooks.dispatch('order.status_changed', { orderId, previousStatus: prevStatus, newStatus: body.status }).catch(() => void 0)
    if (body.status === 'shipped')   this.webhooks.dispatch('order.shipped',   { orderId }).catch(() => void 0)
    if (body.status === 'delivered') this.webhooks.dispatch('order.delivered', { orderId }).catch(() => void 0)
    if (body.status === 'cancelled') this.webhooks.dispatch('order.cancelled', { orderId }).catch(() => void 0)

    return successResponse(updated)
  }

  @Patch(':orderId/tracking')
  @ApiOperation({ summary: '[Admin] Set tracking number' })
  @ApiParam({ name: 'orderId' })
  async addTracking(
    @Param('orderId') orderId: string,
    @Body() body: AddTrackingDto,
  ) {
    const order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE order_id=$1', [orderId],
    )
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })

    const wasShipped = ['shipped','delivered'].includes(order.status)
    const timeline   = [...(order.timeline ?? [])]
    if (!wasShipped) {
      timeline.push({ status: 'shipped', timestamp: new Date(), note: `Shipped — tracking: ${body.trackingNumber}` })
    }

    const updated = await this.db.queryOne<any>(
      `UPDATE store.orders
       SET tracking_number=$1,
           estimated_delivery=COALESCE($2, estimated_delivery),
           status=CASE WHEN status NOT IN ('shipped','delivered') THEN 'shipped' ELSE status END,
           timeline=$3,
           updated_at=NOW()
       WHERE order_id=$4 RETURNING *`,
      [body.trackingNumber, body.estimatedDelivery ?? null, JSON.stringify(timeline), orderId],
    )

    if (!order.shipping_email_sent) {
      const user = await this.db.queryOne<any>(
        'SELECT email, first_name FROM store.users WHERE id=$1', [order.user_id],
      )
      if (user) {
        this.mail.sendShippingNotification(user.email, user.first_name, updated).catch(() => void 0)
        await this.db.execute(
          'UPDATE store.orders SET shipping_email_sent=true WHERE order_id=$1', [orderId],
        ).catch(() => void 0)
      }
    }

    if (!wasShipped) {
      this.webhooks.dispatch('order.shipped', { orderId, trackingNumber: body.trackingNumber }).catch(() => void 0)
    }

    return successResponse(updated)
  }
}
