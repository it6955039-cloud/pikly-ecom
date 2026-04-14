// src/cart/cart.service.ts — PostgreSQL rewrite
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common'
import { ConfigService }   from '@nestjs/config'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'
import { AddToCartDto, UpdateCartDto, RemoveFromCartDto, ApplyCouponDto, MergeCartDto } from './dto/cart.dto'

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name)
  // FIX: read via ConfigService so Railway env var changes take effect without rebuild
  private readonly freeShipThreshold: number
  private readonly flatShipCost: number
  private readonly taxRate: number

  constructor(
    private readonly db:       DatabaseService,
    private readonly products: ProductsService,
    private readonly config:   ConfigService,
  ) {
    this.freeShipThreshold = parseFloat(this.config.get('FREE_SHIPPING_THRESHOLD') ?? '50')
    this.flatShipCost      = parseFloat(this.config.get('FLAT_SHIPPING_COST')      ?? '9.99')
    this.taxRate           = parseFloat(this.config.get('TAX_RATE')                ?? '0.10')
  }

  private async getOrCreate(sessionId: string) {
    let cart = await this.db.queryOne<any>('SELECT * FROM store.carts WHERE session_id=$1', [sessionId])
    if (!cart) {
      cart = await this.db.queryOne<any>(
        `INSERT INTO store.carts (session_id) VALUES ($1) RETURNING *`, [sessionId])
    }
    return cart
  }

  private computeSummary(items: any[], coupon: any) {
    const subtotal = parseFloat(items.reduce((s, i) => s + (i.subtotal ?? 0), 0).toFixed(2))
    const shipping = subtotal === 0 ? 0 : subtotal >= this.freeShipThreshold ? 0 : this.flatShipCost
    let discount = 0
    if (coupon) {
      if (coupon.type === 'percentage')   discount = parseFloat((subtotal * coupon.value / 100).toFixed(2))
      else if (coupon.type === 'fixed')   discount = Math.min(coupon.value, subtotal)
      else if (coupon.type === 'free_shipping') discount = shipping
      if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount)
    }
    const tax   = parseFloat(((subtotal - discount) * this.taxRate).toFixed(2))
    const total = parseFloat(Math.max(0, subtotal + shipping + tax - discount).toFixed(2))
    return { subtotal, shipping, tax, discount, total, itemCount: items.length }
  }

  async getCart(sessionId: string) {
    const cart = await this.getOrCreate(sessionId)
    return { ...cart, items: cart.items ?? [], summary: this.computeSummary(cart.items ?? [], cart.coupon) }
  }

  async addItem(dto: AddToCartDto & { sessionId: string }, userId?: string) {
    const { sessionId } = dto
    const cart = await this.getOrCreate(sessionId)
    const product = this.products.findProductByAsin(dto.productId) ?? this.products.findProductBySlug(dto.productId)
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' })

    const p     = product as any
    const price = p.price ?? p.productResults?.extracted_price ?? 0
    const items: any[] = cart.items ?? []
    const existingIdx  = items.findIndex(i => i.productId === dto.productId && i.variantId === (dto.variantId ?? null))

    if (existingIdx !== -1) {
      items[existingIdx].quantity = Math.min(items[existingIdx].quantity + (dto.quantity ?? 1), 10)
      items[existingIdx].subtotal = parseFloat((items[existingIdx].quantity * price).toFixed(2))
    } else {
      const qty = Math.max(1, Math.min(dto.quantity ?? 1, 10))
      items.push({
        productId:   dto.productId,
        variantId:   dto.variantId ?? null,
        slug:        p.slug,
        title:       p.productResults?.title ?? p.title ?? '',
        brand:       p.brand ?? '',
        image:       p.thumbnail ?? p.productResults?.thumbnail ?? '',
        price,
        quantity:    qty,
        subtotal:    parseFloat((qty * price).toFixed(2)),
      })
    }

    const updated = await this.db.queryOne<any>(
      `UPDATE store.carts SET items=$1, user_id=COALESCE($2::uuid,user_id), updated_at=NOW()
       WHERE session_id=$3 RETURNING *`,
      [JSON.stringify(items), userId ?? null, sessionId],
    )
    return { ...updated, summary: this.computeSummary(items, updated?.coupon) }
  }

  async updateItem(dto: UpdateCartDto & { sessionId: string }) {
    const { sessionId } = dto
    const cart  = await this.getOrCreate(sessionId)
    const items: any[] = cart.items ?? []
    const idx   = items.findIndex(i =>
      i.productId === dto.productId &&
      (dto.variantId === undefined || dto.variantId === null
        ? true
        : i.variantId === dto.variantId)
    )
    if (idx === -1) throw new NotFoundException({ code: 'ITEM_NOT_FOUND' })
    if (dto.quantity <= 0) {
      items.splice(idx, 1)
    } else {
      items[idx].quantity = Math.min(dto.quantity, 10)
      items[idx].subtotal = parseFloat((items[idx].quantity * items[idx].price).toFixed(2))
    }
    const updated = await this.db.queryOne<any>('UPDATE store.carts SET items=$1,updated_at=NOW() WHERE session_id=$2 RETURNING *', [JSON.stringify(items), sessionId])
    return { ...updated, summary: this.computeSummary(items, updated?.coupon) }
  }

  async removeItem(dto: { productId: string; variantId?: string; sessionId: string }) {
    const { sessionId } = dto
    const cart  = await this.getOrCreate(sessionId)
    const items = (cart.items ?? []).filter((i: any) => i.productId !== dto.productId)
    const updated = await this.db.queryOne<any>('UPDATE store.carts SET items=$1,updated_at=NOW() WHERE session_id=$2 RETURNING *', [JSON.stringify(items), sessionId])
    return { ...updated, summary: this.computeSummary(items, updated?.coupon) }
  }

  async clearCart(sessionId: string) {
    await this.db.execute('UPDATE store.carts SET items=$1,coupon=NULL,updated_at=NOW() WHERE session_id=$2', [JSON.stringify([]), sessionId])
    return { cleared: true }
  }

  async applyCoupon(dto: ApplyCouponDto & { sessionId: string }, userId: string | null) {
    const { sessionId } = dto
    const coupon = await this.db.queryOne<any>(
      `SELECT * FROM store.coupons WHERE code=UPPER($1) AND is_active=true AND expires_at>NOW()`,
      [dto.code],
    )
    if (!coupon) throw new BadRequestException({ code: 'INVALID_COUPON', message: 'Invalid or expired coupon' })
    if (coupon.used_count >= coupon.usage_limit) throw new BadRequestException({ code: 'COUPON_EXHAUSTED' })
    if (userId && coupon.used_by_user_ids.includes(userId)) throw new BadRequestException({ code: 'COUPON_ALREADY_USED' })

    const cart = await this.getOrCreate(sessionId)
    const summary = this.computeSummary(cart.items ?? [], null)
    if (summary.subtotal < coupon.min_order_amount) throw new BadRequestException({ code: 'COUPON_MIN_ORDER', message: `Minimum order $${coupon.min_order_amount}` })

    const updated = await this.db.queryOne<any>('UPDATE store.carts SET coupon=$1,updated_at=NOW() WHERE session_id=$2 RETURNING *', [JSON.stringify(coupon), sessionId])
    return { ...updated, summary: this.computeSummary(updated?.items ?? [], coupon) }
  }

  async removeCoupon(sessionId: string) {
    const updated = await this.db.queryOne<any>('UPDATE store.carts SET coupon=NULL,updated_at=NOW() WHERE session_id=$1 RETURNING *', [sessionId])
    return { ...updated, summary: this.computeSummary(updated?.items ?? [], null) }
  }

  async mergeCart(dto: MergeCartDto & { userId: string }) {
    const { userId } = dto
    const guest = await this.db.queryOne<any>('SELECT * FROM store.carts WHERE session_id=$1', [dto.guestSessionId])
    if (!guest || !(guest.items ?? []).length) return { merged: false }
    const userSessionId = `user:${userId}`
    let userCart = await this.db.queryOne<any>('SELECT * FROM store.carts WHERE session_id=$1', [userSessionId])
    if (!userCart) {
      // No user cart exists yet — just claim the guest cart
      await this.db.execute(
        'UPDATE store.carts SET session_id=$1, user_id=$2, updated_at=NOW() WHERE session_id=$3',
        [userSessionId, userId, dto.guestSessionId],
      )
      return { merged: true }
    }
    // Merge: combine items by productId+variantId key, summing quantities (capped at 10)
    const itemMap = new Map<string, any>()
    for (const item of (userCart.items ?? [])) {
      const key = `${item.productId}::${item.variantId ?? ''}`
      itemMap.set(key, { ...item })
    }
    for (const item of (guest.items ?? [])) {
      const key = `${item.productId}::${item.variantId ?? ''}`
      if (itemMap.has(key)) {
        const existing = itemMap.get(key)!
        existing.quantity = Math.min(existing.quantity + item.quantity, 10)
        existing.subtotal = parseFloat((existing.quantity * existing.price).toFixed(2))
      } else {
        itemMap.set(key, { ...item })
      }
    }
    const mergedItems = Array.from(itemMap.values())
    await this.db.execute(
      'UPDATE store.carts SET items=$1, user_id=$2, updated_at=NOW() WHERE session_id=$3',
      [JSON.stringify(mergedItems), userId, userSessionId],
    )
    await this.db.execute('DELETE FROM store.carts WHERE session_id=$1', [dto.guestSessionId])
    return { merged: true }
  }

  async getSummary(sessionId: string) {
    const cart = await this.db.queryOne<any>('SELECT items, coupon FROM store.carts WHERE session_id=$1', [sessionId])
    const items = cart?.items ?? []
    return this.computeSummary(items, cart?.coupon)
  }

  async getCartByUser(userId: string) {
    const cart = await this.db.queryOne<any>('SELECT * FROM store.carts WHERE user_id=$1', [userId])
    if (!cart) return null
    return { ...cart, summary: this.computeSummary(cart.items ?? [], cart.coupon) }
  }
}
