// src/orders/orders.service.ts
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CartService } from '../cart/cart.service'
import { DatabaseService } from '../database/database.service'
import { MailService } from '../mail/mail.service'
import { ProductsService } from '../products/products.service'
import { RedisService } from '../redis/redis.service'
import { WebhookService } from '../webhooks/webhook.service'
import { CreateOrderDto } from './dto/create-order.dto'

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)
  private readonly freeShipThreshold: number
  private readonly flatShipCost: number

  constructor(
    private readonly db: DatabaseService,
    private readonly cartService: CartService,
    private readonly products: ProductsService,
    private readonly mail: MailService,
    private readonly redis: RedisService,
    private readonly webhooks: WebhookService,
    private readonly config: ConfigService,
  ) {
    this.freeShipThreshold = parseFloat(this.config.get('FREE_SHIPPING_THRESHOLD') ?? '50')
    this.flatShipCost = parseFloat(this.config.get('FLAT_SHIPPING_COST') ?? '9.99')
  }

  private async nextOrderId(): Promise<string> {
    const row = await this.db.queryOne<{ nextval: string }>('SELECT nextval($1) AS nextval', [
      'store.order_seq',
    ])
    return `ORD-${String(row?.nextval ?? Date.now()).padStart(6, '0')}`
  }

  async create(userId: string, dto: CreateOrderDto) {
    // DES-03: Idempotency — prevent duplicate orders on client retry
    if (dto.idempotencyKey) {
      const existing = await this.redis.getIdempotencyKey(dto.idempotencyKey)
      if (existing) {
        this.logger.log(`Idempotent replay: key=${dto.idempotencyKey} → ${existing}`)
        const order = await this.db.queryOne<any>('SELECT * FROM store.orders WHERE order_id=$1', [
          existing,
        ])
        if (order) return order
      }
    }

    const cartData = await this.cartService.getCartByUser(userId)
    if (!cartData || !(cartData.items ?? []).length) {
      throw new BadRequestException({ code: 'CART_EMPTY' })
    }

    const summary = cartData.summary
    const orderId = await this.nextOrderId()

    for (const item of cartData.items) {
      if (!this.products.findProductByAsin(item.asin)) {
        throw new BadRequestException({
          code: 'PRODUCT_NOT_FOUND',
          message: `Product ${item.asin} not found`,
        })
      }
    }

    // Coupon + order in a single serialisable transaction.
    // SELECT FOR UPDATE on the coupon row prevents concurrent orders from
    // passing the capacity/per-user checks simultaneously (race condition fix).
    const order = await this.db.transaction(async (client) => {
      let couponApplied: { code: string; type: string; value: number; discount: number } | null =
        null
      if (cartData.coupon) {
        const c = cartData.coupon

        // Lock the coupon row for the duration of this transaction so no two
        // concurrent checkouts can over-consume the same coupon.
        const freshCoupon = await client.query(
          `SELECT used_count, usage_limit, used_by_user_ids
           FROM store.coupons WHERE code = $1 AND is_active = true FOR UPDATE`,
          [c.code],
        )
        const couponRow = freshCoupon.rows[0]
        if (!couponRow) {
          throw new BadRequestException({
            code: 'COUPON_INVALID',
            message: 'Coupon is no longer valid',
          })
        }
        if (couponRow.used_count >= couponRow.usage_limit) {
          throw new BadRequestException({
            code: 'COUPON_EXHAUSTED',
            message: 'Coupon usage limit reached',
          })
        }
        if ((couponRow.used_by_user_ids ?? []).includes(userId)) {
          throw new BadRequestException({
            code: 'COUPON_ALREADY_USED',
            message: 'You have already used this coupon',
          })
        }

        couponApplied = { code: c.code, type: c.type, value: c.value, discount: summary.discount }
        await client.query(
          `UPDATE store.coupons
           SET used_count = used_count + 1,
               used_by_user_ids = array_append(used_by_user_ids, $1)
           WHERE code = $2`,
          [userId, c.code],
        )
      }
      const res = await client.query(
        `INSERT INTO store.orders
           (order_id,user_id,items,pricing,coupon_applied,shipping_address,payment_method,timeline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          orderId,
          userId,
          JSON.stringify(cartData.items),
          JSON.stringify({ ...summary, currency: 'USD' }),
          couponApplied ? JSON.stringify(couponApplied) : null,
          JSON.stringify(dto.shippingAddress),
          dto.paymentMethod,
          JSON.stringify([{ status: 'pending', timestamp: new Date(), note: 'Order placed' }]),
        ],
      )
      return res.rows[0]
    })

    // Post-order side-effects (outside tx — failures don't roll back the order)
    await this.cartService.clearCart(cartData.session_id)
    await this.redis.del(`cart:${userId}`)

    const user = await this.db.queryOne<any>(
      'SELECT email, first_name FROM store.users WHERE id=$1',
      [userId],
    )
    await this.mail.sendOrderConfirmation(user?.email, user?.first_name, order).catch(() => void 0)
    await this.webhooks
      .dispatch('order.created', { orderId, userId, total: summary.total })
      .catch(() => void 0)
    // NOTE: Loyalty points are awarded on ORDER DELIVERY (admin marks as delivered),
    // not at order placement.  Awarding at both points caused users to receive
    // double points.  See admin-orders.controller.ts updateStatus() for award logic.

    if (dto.idempotencyKey) {
      await this.redis.setIdempotencyKey(dto.idempotencyKey, order.order_id).catch(() => void 0)
    }

    return order
  }

  async findUserOrders(userId: string, page = 1, limit = 10) {
    const offset = (page - 1) * limit
    const [rows, countRow] = await Promise.all([
      this.db.query<any>(
        `SELECT order_id, user_id, status, payment_method, payment_status,
                pricing, coupon_applied, shipping_address, tracking_number,
                timeline, created_at, updated_at
         FROM store.orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      this.db.queryOne<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM store.orders WHERE user_id=$1',
        [userId],
      ),
    ])
    return {
      orders: rows,
      total: countRow?.cnt ?? 0,
      page,
      limit,
      totalPages: Math.ceil((countRow?.cnt ?? 0) / limit),
    }
  }

  async findOne(orderId: string, userId: string) {
    const order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE order_id=$1 AND user_id=$2',
      [orderId, userId],
    )
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })
    return order
  }

  async updateStatus(orderId: string, status: string, note?: string) {
    const order = await this.db.queryOne<any>('SELECT * FROM store.orders WHERE order_id=$1', [
      orderId,
    ])
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })
    const timeline = [
      ...(order.timeline ?? []),
      { status, timestamp: new Date(), note: note ?? '' },
    ]
    const updated = await this.db.queryOne<any>(
      'UPDATE store.orders SET status=$1,timeline=$2,updated_at=NOW() WHERE order_id=$3 RETURNING *',
      [status, JSON.stringify(timeline), orderId],
    )
    await this.webhooks.dispatch('order.status_changed', {
      orderId,
      status,
      timeline: updated.timeline,
    })
    if (status === 'shipped' && !order.shipping_email_sent) {
      const user = await this.db.queryOne<any>(
        'SELECT email,first_name FROM store.users WHERE id=$1',
        [order.user_id],
      )
      await this.mail
        .sendShippingNotification(user?.email, user?.first_name, updated)
        .catch(() => void 0)
      await this.db.execute('UPDATE store.orders SET shipping_email_sent=true WHERE order_id=$1', [
        orderId,
      ])
    }
    return updated
  }

  async addTracking(orderId: string, trackingNumber: string) {
    const order = await this.db.queryOne<any>('SELECT * FROM store.orders WHERE order_id=$1', [
      orderId,
    ])
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })
    const updated = await this.db.queryOne<any>(
      'UPDATE store.orders SET tracking_number=$1,updated_at=NOW() WHERE order_id=$2 RETURNING *',
      [trackingNumber, orderId],
    )
    if (!order.shipping_email_sent) {
      const user = await this.db.queryOne<any>(
        'SELECT email,first_name FROM store.users WHERE id=$1',
        [order.user_id],
      )
      await this.mail
        .sendShippingNotification(user?.email, user?.first_name, updated)
        .catch(() => void 0)
      await this.db.execute('UPDATE store.orders SET shipping_email_sent=true WHERE order_id=$1', [
        orderId,
      ])
    }
    return updated
  }

  // FIX: SELECT specific columns — no large JSONB blobs in list view
  async adminFindAll(page = 1, limit = 20, status?: string) {
    const offset = (page - 1) * limit
    const params: any[] = [limit, offset]
    const where = status ? `WHERE o.status = $${params.push(status)}` : ''
    const [rows, count] = await Promise.all([
      this.db.query<any>(
        `SELECT o.order_id, o.user_id, o.status, o.payment_method, o.payment_status,
                o.pricing, o.tracking_number, o.created_at, o.updated_at,
                u.email, u.first_name
         FROM store.orders o
         JOIN store.users u ON u.id = o.user_id
         ${where} ORDER BY o.created_at DESC LIMIT $1 OFFSET $2`,
        params,
      ),
      this.db.queryOne<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM store.orders o ${where}`,
        status ? [status] : [],
      ),
    ])
    return { orders: rows, total: count?.cnt ?? 0, page, limit }
  }

  async cancelOrder(orderId: string, userId: string) {
    const order = await this.db.queryOne<any>(
      'SELECT * FROM store.orders WHERE order_id=$1 AND user_id=$2',
      [orderId, userId],
    )
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' })

    const cancelable = ['pending', 'confirmed']
    if (!cancelable.includes(order.status)) {
      throw new BadRequestException({
        code: 'ORDER_NOT_CANCELABLE',
        message: `Orders in "${order.status}" status cannot be cancelled.`,
      })
    }

    const timeline = [
      ...(order.timeline ?? []),
      { status: 'cancelled', timestamp: new Date(), note: 'Cancelled by customer' },
    ]
    const paymentStatus = order.payment_method === 'cod' ? 'cancelled' : 'pending_refund'
    const updated = await this.db.queryOne<any>(
      `UPDATE store.orders
       SET status='cancelled', payment_status=$1, timeline=$2, updated_at=NOW()
       WHERE order_id=$3 RETURNING *`,
      [paymentStatus, JSON.stringify(timeline), orderId],
    )
    await this.webhooks.dispatch('order.cancelled', { orderId, userId }).catch(() => void 0)
    return updated
  }

  async createOrder(userId: string, dto: CreateOrderDto) {
    return this.create(userId, dto)
  }

  async getUserOrders(userId: string, opts: { page?: number; limit?: number; status?: string }) {
    const { page = 1, limit = 10, status } = opts
    if (status) {
      const offset = (page - 1) * limit
      const [rows, ct] = await Promise.all([
        this.db.query<any>(
          `SELECT order_id, user_id, status, payment_method, pricing,
                  shipping_address, tracking_number, timeline, created_at
           FROM store.orders WHERE user_id=$1 AND status=$2
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [userId, status, limit, offset],
        ),
        this.db.queryOne<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM store.orders WHERE user_id=$1 AND status=$2',
          [userId, status],
        ),
      ])
      return {
        orders: rows,
        total: ct?.cnt ?? 0,
        page,
        limit,
        totalPages: Math.ceil((ct?.cnt ?? 0) / limit),
      }
    }
    return this.findUserOrders(userId, page, limit)
  }

  async getOrder(orderId: string, userId: string) {
    return this.findOne(orderId, userId)
  }

  async trackOrder(orderId: string, userId: string) {
    const order = await this.findOne(orderId, userId)
    return {
      orderId: order.order_id,
      status: order.status,
      trackingNumber: order.tracking_number ?? null,
      estimatedDelivery: order.estimated_delivery ?? null,
      timeline: order.timeline ?? [],
      shippingAddress: order.shipping_address,
    }
  }

  async calculateShipping(sessionId: string, _addressId: string, _userId: string) {
    const cart = await this.db.queryOne<any>('SELECT items FROM store.carts WHERE session_id=$1', [
      sessionId,
    ])
    const items = cart?.items ?? []
    const subtotal = items.reduce((s: number, i: any) => s + (i.subtotal ?? 0), 0)
    const shipping = subtotal === 0 ? 0 : subtotal >= this.freeShipThreshold ? 0 : this.flatShipCost
    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      shipping,
      freeShippingThreshold: this.freeShipThreshold,
    }
  }
}
