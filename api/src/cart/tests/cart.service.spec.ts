// src/cart/tests/cart.service.spec.ts — PostgreSQL, no Mongoose
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'
import { DatabaseService } from '../../database/database.service'
import { ProductsService } from '../../products/products.service'
import { CartService } from '../cart.service'

const SESSION = 'test-session-abc'
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000001'

const mockProduct = {
  asin: 'B001',
  slug: 'widget',
  title: 'Widget Pro',
  brand: 'Acme',
  price: 19.99,
  productResults: { title: 'Widget Pro', thumbnail: 'img.jpg' },
}

function makeDatabaseService() {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue(1),
  }
}

function makeEmptyCart(overrides: any = {}) {
  return {
    session_id: SESSION,
    user_id: null,
    items: [],
    coupon: null,
    ...overrides,
  }
}

describe('CartService', () => {
  let service: CartService
  let db: ReturnType<typeof makeDatabaseService>
  let productsService: any

  beforeEach(async () => {
    db = makeDatabaseService()
    productsService = {
      findProductByAsin: jest.fn().mockReturnValue(mockProduct),
      findProductBySlug: jest.fn().mockReturnValue(null),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: DatabaseService, useValue: db },
        { provide: ProductsService, useValue: productsService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile()

    service = module.get<CartService>(CartService)
  })

  // ── getCart ────────────────────────────────────────────────────────────────

  describe('getCart', () => {
    it('creates a new empty cart when session does not exist', async () => {
      db.queryOne
        .mockResolvedValueOnce(null) // SELECT — not found
        .mockResolvedValueOnce(makeEmptyCart()) // INSERT RETURNING

      const result = await service.getCart(SESSION)
      expect(result.items).toHaveLength(0)
      expect(result.summary.total).toBe(0)
    })

    it('returns existing cart with correct summary', async () => {
      const cartWithItem = makeEmptyCart({
        items: [{ productId: 'B001', price: 19.99, quantity: 2, subtotal: 39.98 }],
      })
      db.queryOne.mockResolvedValueOnce(cartWithItem)

      const result = await service.getCart(SESSION)
      expect(result.items).toHaveLength(1)
      expect(result.summary.subtotal).toBeCloseTo(39.98)
    })
  })

  // ── addItem ────────────────────────────────────────────────────────────────

  describe('addItem', () => {
    it('throws PRODUCT_NOT_FOUND for unknown productId', async () => {
      productsService.findProductByAsin.mockReturnValueOnce(undefined)
      productsService.findProductBySlug.mockReturnValueOnce(undefined)
      db.queryOne.mockResolvedValueOnce(makeEmptyCart())

      await expect(
        service.addItem({ sessionId: SESSION, productId: 'UNKNOWN', quantity: 1 }),
      ).rejects.toThrow(NotFoundException)
    })

    it('adds a new item to empty cart', async () => {
      const emptyCart = makeEmptyCart()
      const updatedCart = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 1, price: 19.99, subtotal: 19.99 }],
      })
      db.queryOne
        .mockResolvedValueOnce(emptyCart) // getOrCreate
        .mockResolvedValueOnce(updatedCart) // UPDATE RETURNING

      const result = await service.addItem({ sessionId: SESSION, productId: 'B001', quantity: 1 })
      expect(result.items).toHaveLength(1)
      expect(result.summary.subtotal).toBeCloseTo(19.99)
    })

    it('increments quantity when same item is added again', async () => {
      const cartWithItem = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 1, price: 19.99, subtotal: 19.99 }],
      })
      const updatedCart = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 2, price: 19.99, subtotal: 39.98 }],
      })
      db.queryOne.mockResolvedValueOnce(cartWithItem).mockResolvedValueOnce(updatedCart)

      const result = await service.addItem({ sessionId: SESSION, productId: 'B001', quantity: 1 })
      expect(result.items[0].quantity).toBe(2)
    })

    it('caps quantity at 10', async () => {
      const cartWithItem = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 9, price: 19.99, subtotal: 179.91 }],
      })
      db.queryOne.mockResolvedValueOnce(cartWithItem).mockResolvedValueOnce(
        makeEmptyCart({
          items: [{ productId: 'B001', quantity: 10, price: 19.99, subtotal: 199.9 }],
        }),
      )

      const result = await service.addItem({ sessionId: SESSION, productId: 'B001', quantity: 5 })
      expect(result.items[0].quantity).toBe(10)
    })
  })

  // ── updateItem ─────────────────────────────────────────────────────────────

  describe('updateItem', () => {
    it('throws ITEM_NOT_FOUND for unknown productId', async () => {
      db.queryOne.mockResolvedValueOnce(makeEmptyCart({ items: [] }))
      await expect(
        service.updateItem({ sessionId: SESSION, productId: 'UNKNOWN', quantity: 2 }),
      ).rejects.toThrow(NotFoundException)
    })

    it('removes item when quantity is set to 0', async () => {
      const cart = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 2, price: 19.99, subtotal: 39.98 }],
      })
      db.queryOne.mockResolvedValueOnce(cart).mockResolvedValueOnce(makeEmptyCart({ items: [] }))

      const result = await service.updateItem({
        sessionId: SESSION,
        productId: 'B001',
        quantity: 0,
      })
      expect(result.items).toHaveLength(0)
    })
  })

  // ── applyCoupon ────────────────────────────────────────────────────────────

  describe('applyCoupon', () => {
    it('throws INVALID_COUPON for expired or inactive coupon', async () => {
      db.queryOne.mockReset().mockResolvedValueOnce(null) // coupon not found

      await expect(
        service.applyCoupon({ sessionId: SESSION, code: 'BADCODE' }, null),
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── computeSummary ─────────────────────────────────────────────────────────

  describe('computeSummary (via getCart)', () => {
    it('applies free shipping above threshold', async () => {
      const cart = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 3, price: 25, subtotal: 75 }],
      })
      db.queryOne.mockResolvedValueOnce(cart)

      const result = await service.getCart(SESSION)
      expect(result.summary.shipping).toBe(0)
    })

    it('adds flat shipping rate below threshold', async () => {
      const cart = makeEmptyCart({
        items: [{ productId: 'B001', quantity: 1, price: 10, subtotal: 10 }],
      })
      db.queryOne.mockResolvedValueOnce(cart)

      const result = await service.getCart(SESSION)
      expect(result.summary.shipping).toBeGreaterThan(0)
    })
  })
})
