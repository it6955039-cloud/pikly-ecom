import { Injectable, NotFoundException } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'

@Injectable()
export class WishlistService {
  constructor(
    private readonly db:       DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async getWishlist(userId: string) {
    const rows = await this.db.query<{ asin: string; added_at: Date }>(
      'SELECT asin, added_at FROM store.wishlists WHERE user_id=$1 ORDER BY added_at DESC',
      [userId],
    )
    return rows.map(r => {
      const product = this.products.findProductByAsin(r.asin)
      return product
        ? { asin: r.asin, addedAt: r.added_at, product }
        : { asin: r.asin, addedAt: r.added_at, product: null }
    })
  }

  async addToWishlist(userId: string, asin: string) {
    if (!this.products.findProductByAsin(asin)) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' })
    await this.db.execute(
      'INSERT INTO store.wishlists (user_id, asin) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [userId, asin],
    )
    return { added: true, asin }
  }

  async removeFromWishlist(userId: string, asin: string) {
    await this.db.execute('DELETE FROM store.wishlists WHERE user_id=$1 AND asin=$2', [userId, asin])
    return { removed: true, asin }
  }

  async isInWishlist(userId: string, asin: string): Promise<boolean> {
    const row = await this.db.queryOne('SELECT 1 FROM store.wishlists WHERE user_id=$1 AND asin=$2', [userId, asin])
    return !!row
  }

  async toggle(userId: string, productId: string) {
    const inWishlist = await this.isInWishlist(userId, productId)
    if (inWishlist) return this.removeFromWishlist(userId, productId)
    return this.addToWishlist(userId, productId)
  }

  async check(userId: string, productId: string) {
    const inWishlist = await this.isInWishlist(userId, productId)
    return { productId, inWishlist }
  }
}