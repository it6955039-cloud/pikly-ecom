import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'

const MAX_RECENT = 20

@Injectable()
export class RecentlyViewedService {
  constructor(
    private readonly db:       DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async track(userId: string, asin: string) {
    await this.db.execute(
      `INSERT INTO store.recently_viewed (user_id, asin, viewed_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id, asin) DO UPDATE SET viewed_at = NOW()`,
      [userId, asin],
    )
    // Trim to MAX_RECENT — keep most recent
    await this.db.execute(
      `DELETE FROM store.recently_viewed
       WHERE user_id=$1 AND asin NOT IN (
         SELECT asin FROM store.recently_viewed WHERE user_id=$1
         ORDER BY viewed_at DESC LIMIT $2
       )`,
      [userId, MAX_RECENT],
    )
  }

  async getRecentlyViewed(userId: string, limit = 10) {
    const rows = await this.db.query<{ asin: string; viewed_at: Date }>(
      'SELECT asin, viewed_at FROM store.recently_viewed WHERE user_id=$1 ORDER BY viewed_at DESC LIMIT $2',
      [userId, limit],
    )
    return rows.map(r => ({
      asin: r.asin,
      viewedAt: r.viewed_at,
      product: this.products.findProductByAsin(r.asin) ?? null,
    })).filter(r => r.product)
  }

  async getRecent(userId: string, opts: { page?: number; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(50, Math.max(1, opts.limit ?? 10))
    const items = await this.getRecentlyViewed(userId, limit)
    return { items, total: items.length, limit }
  }
}