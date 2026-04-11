import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'

@Injectable()
export class CouponsService {
  constructor(private readonly db: DatabaseService) {}

  async validate(code: string, userId?: string, orderTotal?: number) {
    const coupon = await this.db.queryOne<any>(
      'SELECT * FROM store.coupons WHERE code=UPPER($1) AND is_active=true AND expires_at>NOW()',
      [code],
    )
    if (!coupon) throw new NotFoundException({ code: 'COUPON_NOT_FOUND', message: 'Invalid or expired coupon' })
    if (coupon.used_count >= coupon.usage_limit) throw new BadRequestException({ code: 'COUPON_EXHAUSTED' })
    if (userId && coupon.used_by_user_ids.includes(userId)) throw new BadRequestException({ code: 'COUPON_ALREADY_USED' })
    if (orderTotal !== undefined && orderTotal < coupon.min_order_amount) {
      throw new BadRequestException({ code: 'COUPON_MIN_ORDER', message: `Min order: $${coupon.min_order_amount}` })
    }
    return coupon
  }

  async adminCreate(dto: any) {
    return this.db.queryOne<any>(
      `INSERT INTO store.coupons (id,code,type,value,min_order_amount,max_discount,usage_limit,applicable_categories,applicable_products,expires_at,is_active)
       VALUES ($1,UPPER($2),$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [dto.id ?? `coup_${Date.now()}`, dto.code, dto.type, dto.value,
       dto.minOrderAmount??0, dto.maxDiscount??null, dto.usageLimit??1000,
       dto.applicableCategories??[], dto.applicableProducts??[],
       dto.expiresAt, dto.isActive??true],
    )
  }

  async adminFindAll(page = 1, limit = 20) {
    const offset = (page-1)*limit
    const [rows,ct] = await Promise.all([
      this.db.query<any>('SELECT * FROM store.coupons ORDER BY created_at DESC LIMIT $1 OFFSET $2',[limit,offset]),
      this.db.queryOne<{cnt:number}>('SELECT COUNT(*)::int AS cnt FROM store.coupons'),
    ])
    return { coupons: rows, total: ct?.cnt??0, page, limit }
  }

  async adminUpdate(id: string, dto: any) {
    const sets = ['updated_at=NOW()']; const vals: any[] = []; let i=1
    for (const k of ['code','type','value','min_order_amount','usage_limit','expires_at','is_active']) {
      if (k in dto) { sets.push(`${k}=$${i++}`); vals.push(dto[k]) }
    }
    vals.push(id)
    return this.db.queryOne<any>(`UPDATE store.coupons SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals)
  }

  async adminDelete(id: string) {
    await this.db.execute('UPDATE store.coupons SET is_active=false WHERE id=$1', [id])
    return { deleted: true }
  }
}
