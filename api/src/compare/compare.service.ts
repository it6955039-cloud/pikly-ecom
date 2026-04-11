import { Injectable, BadRequestException } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { ProductsService } from '../products/products.service'

@Injectable()
export class CompareService {
  constructor(
    private readonly db:       DatabaseService,
    private readonly products: ProductsService,
  ) {}

  async getList(sessionId: string) {
    const row = await this.db.queryOne<{ asins: string[] }>('SELECT asins FROM store.compare_lists WHERE session_id=$1', [sessionId])
    const asins = row?.asins ?? []
    return { asins, products: asins.map(a => this.products.findProductByAsin(a)).filter(Boolean) }
  }

  async add(sessionId: string, asin: string) {
    const row = await this.db.queryOne<{ asins: string[] }>('SELECT asins FROM store.compare_lists WHERE session_id=$1', [sessionId])
    const asins = row?.asins ?? []
    if (asins.includes(asin)) return { asins }
    if (asins.length >= 4) throw new BadRequestException({ code: 'COMPARE_LIMIT', message: 'Max 4 products to compare' })
    const newAsins = [...asins, asin]
    await this.db.execute(
      `INSERT INTO store.compare_lists (session_id, asins) VALUES ($1,$2)
       ON CONFLICT (session_id) DO UPDATE SET asins=$2, updated_at=NOW()`,
      [sessionId, newAsins],
    )
    return { asins: newAsins }
  }

  async remove(sessionId: string, asin: string) {
    const row = await this.db.queryOne<{ asins: string[] }>('SELECT asins FROM store.compare_lists WHERE session_id=$1', [sessionId])
    const newAsins = (row?.asins ?? []).filter(a => a !== asin)
    await this.db.execute('UPDATE store.compare_lists SET asins=$1,updated_at=NOW() WHERE session_id=$2', [newAsins, sessionId])
    return { asins: newAsins }
  }

  async clear(sessionId: string) {
    await this.db.execute('UPDATE store.compare_lists SET asins=$1,updated_at=NOW() WHERE session_id=$2', [[], sessionId])
    return { cleared: true }
  }

  compare(productIds: string[]) {
    const products = productIds
      .map(id => this.products.findProductByAsin(id) ?? this.products.findProductBySlug(id))
      .filter(Boolean)
    return { products }
  }
}