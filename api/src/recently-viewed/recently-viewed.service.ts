import { Injectable, Logger } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'
import { RedisService } from '../redis/redis.service'
import { smartPaginate } from '../common/api-utils'

const MAX_RECENT = 20

// Redis channel consumed by PersonalizationService to flush per-user P13N cache.
// Payload: JSON string '{"userId":"<uuid>"}'
const P13N_INVALIDATE_CHANNEL = 'p13n:user:viewed'

@Injectable()
export class RecentlyViewedService {
  private readonly logger = new Logger(RecentlyViewedService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsService,
    private readonly redis: RedisService, // @Global — no module import needed
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

    // Signal PersonalizationService to invalidate the stale P13N cache for this user.
    // Fire-and-forget — a Redis failure here must never fail the track() call itself.
    this.redis
      .publish(P13N_INVALIDATE_CHANNEL, JSON.stringify({ userId }))
      .catch((err) =>
        this.logger.warn(`P13N invalidation publish failed for user ${userId}: ${err.message}`),
      )
  }

  async getRecentlyViewed(userId: string, limit = 10) {
    const rows = await this.db.query<{ asin: string; viewed_at: Date }>(
      'SELECT asin, viewed_at FROM store.recently_viewed WHERE user_id=$1 ORDER BY viewed_at DESC LIMIT $2',
      [userId, limit],
    )
    return rows
      .map((r) => ({
        asin: r.asin,
        viewedAt: r.viewed_at,
        product: this.products.findProductByAsin(r.asin) ?? null,
      }))
      .filter((r) => r.product)
  }

  async getRecent(userId: string, opts: { page?: number; limit?: number; cursor?: string } = {}) {
    const { page, cursor } = opts
    const limit = Math.min(50, Math.max(1, opts.limit ?? 10))
    // Fetch the MAX_RECENT ceiling then paginate in-memory — avoids an extra COUNT query
    const allItems = await this.getRecentlyViewed(userId, MAX_RECENT)
    return smartPaginate(allItems, { page, limit, cursor })
  }
}
