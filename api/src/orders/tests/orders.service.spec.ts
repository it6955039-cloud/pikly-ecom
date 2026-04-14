// src/orders/tests/orders.service.spec.ts — PostgreSQL, no Mongoose
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'
import { CartService } from '../../cart/cart.service'
import { DatabaseService } from '../../database/database.service'
import { MailService } from '../../mail/mail.service'
import { ProductsService } from '../../products/products.service'
import { RedisService } from '../../redis/redis.service'
import { WebhookService } from '../../webhooks/webhook.service'
import { OrdersService } from '../orders.service'

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const SESSION_ID = 'sess-abc-123'
const ORDER_ID = 'ORD-001000'

function makeDatabaseService() {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue(1),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: any) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
      ),
  }
}

const mockCartWithItems = {
  session_id: SESSION_ID,
  user_id: USER_ID,
  items: [{ asin: 'B001', title: 'Widget', price: 29.99, quantity: 2, subtotal: 59.98 }],
  coupon: null,
  summary: { subtotal: 59.98, shipping: 0, tax: 5.99, discount: 0, total: 65.97 },
}

describe('OrdersService', () => {
  let service: OrdersService
  let db: ReturnType<typeof makeDatabaseService>
  let cartService: any
  let productsService: any
  let mailService: any
  let webhookService: any
  let redis: any

  beforeEach(async () => {
    db = makeDatabaseService()

    cartService = {
      getCart: jest.fn().mockResolvedValue(mockCartWithItems),
      clearCart: jest.fn().mockResolvedValue({ cleared: true }),
    }

    productsService = {
      findProductByAsin: jest.fn().mockReturnValue({ asin: 'B001', title: 'Widget', price: 29.99 }),
    }

    mailService = {
      sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
      sendShippingNotification: jest.fn().mockResolvedValue(undefined),
    }

    webhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    }

    redis = {
      del: jest.fn().mockResolvedValue(undefined),
      getIdempotencyKey: jest.fn().mockResolvedValue(null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DatabaseService, useValue: db },
        { provide: CartService, useValue: cartService },
        { provide: ProductsService, useValue: productsService },
        { provide: MailService, useValue: mailService },
        { provide: RedisService, useValue: redis },
        { provide: WebhookService, useValue: webhookService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile()

    service = module.get<OrdersService>(OrdersService)
  })

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('throws CART_EMPTY when cart has no items', async () => {
      cartService.getCart.mockResolvedValueOnce({ items: [], summary: {} })
      await expect(
        service.create(USER_ID, { shippingAddress: {}, paymentMethod: 'card' } as any),
      ).rejects.toThrow(BadRequestException)
    })

    it('throws PRODUCT_NOT_FOUND when a cart item references a missing product', async () => {
      productsService.findProductByAsin.mockReturnValueOnce(undefined)
      await expect(
        service.create(USER_ID, { shippingAddress: {}, paymentMethod: 'card' } as any),
      ).rejects.toThrow(BadRequestException)
    })

    it('creates an order and clears the cart on success', async () => {
      // nextOrderId sequence
      db.queryOne
        .mockResolvedValueOnce({ nextval: '1001' }) // nextOrderId
        .mockResolvedValueOnce({ email: 'a@b.com', first_name: 'Alice' }) // user lookup
        .mockResolvedValueOnce({ order_id: ORDER_ID, user_id: USER_ID, status: 'pending' }) // INSERT RETURNING

      const order = await service.create(USER_ID, {
        shippingAddress: { street: '1 Main St', city: 'NYC', zip: '10001' },
        paymentMethod: 'card',
      } as any)

      expect(cartService.clearCart).toHaveBeenCalled()
      expect(mailService.sendOrderConfirmation).toHaveBeenCalled()
      expect(webhookService.dispatch).toHaveBeenCalledWith('order.created', expect.any(Object))
    })
  })

  // ── findUserOrders ─────────────────────────────────────────────────────────

  describe('findUserOrders', () => {
    it('returns empty list when user has no orders', async () => {
      db.query.mockResolvedValueOnce([])
      db.queryOne.mockResolvedValueOnce({ cnt: 0 })
      const result = await service.findUserOrders(USER_ID)
      expect(result.orders).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('throws ORDER_NOT_FOUND for unknown orderId', async () => {
      db.queryOne.mockResolvedValueOnce(null)
      await expect(service.findOne('ORD-UNKNOWN', USER_ID)).rejects.toThrow(NotFoundException)
    })

    it('returns order when found and owned by user', async () => {
      const fakeOrder = { order_id: ORDER_ID, user_id: USER_ID, status: 'pending' }
      db.queryOne.mockResolvedValueOnce(fakeOrder)
      const result = await service.findOne(ORDER_ID, USER_ID)
      expect(result.order_id).toBe(ORDER_ID)
    })
  })

  // ── updateStatus ───────────────────────────────────────────────────────────

  describe('updateStatus', () => {
    const existingOrder = {
      order_id: ORDER_ID,
      user_id: USER_ID,
      status: 'processing',
      payment_method: 'card',
      payment_status: 'pending',
      shipping_email_sent: false,
      timeline: [],
      pricing: { total: 89.99 },
    }

    it('appends new status to timeline', async () => {
      db.queryOne
        .mockResolvedValueOnce(existingOrder) // SELECT
        .mockResolvedValueOnce({ ...existingOrder, status: 'shipped' }) // UPDATE RETURNING

      const result = await service.updateStatus(ORDER_ID, 'shipped')
      expect(webhookService.dispatch).toHaveBeenCalledWith(
        'order.status_changed',
        expect.any(Object),
      )
    })

    it('throws ORDER_NOT_FOUND for missing order', async () => {
      db.queryOne.mockResolvedValueOnce(null)
      await expect(service.updateStatus('BAD-ID', 'shipped')).rejects.toThrow(NotFoundException)
    })
  })
})
