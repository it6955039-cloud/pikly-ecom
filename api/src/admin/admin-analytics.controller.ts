// src/admin/admin-analytics.controller.ts — PostgreSQL rewrite, no Mongoose
import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard }       from '../common/guards/roles.guard'
import { Roles }            from '../common/decorators/roles.decorator'
import { DatabaseService }  from '../database/database.service'
import { successResponse }  from '../common/api-utils'

function parseDateParam(value: string | undefined, param: string): Date | undefined {
  if (value === undefined) return undefined
  const d = new Date(value)
  if (isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'INVALID_DATE',
      message: `"${param}" must be a valid ISO 8601 date (e.g. 2024-01-15T00:00:00Z)`,
    })
  }
  return d
}

@ApiTags('Admin — Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('revenue')
  @ApiOperation({ summary: '[Admin] Revenue summary — total, AOV, by date range' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 8601' })
  @ApiQuery({ name: 'to',   required: false, description: 'ISO 8601' })
  async revenue(@Query('from') from?: string, @Query('to') to?: string) {
    const fromDate = parseDateParam(from, 'from')
    const toDate   = parseDateParam(to,   'to')

    const conditions = [`status NOT IN ('cancelled')`]
    const params: any[] = []
    let idx = 1

    if (fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(fromDate) }
    if (toDate)   { conditions.push(`created_at <= $${idx++}`); params.push(toDate) }

    const where = `WHERE ${conditions.join(' AND ')}`

    const row = await this.db.queryOne<any>(
      `SELECT
         COALESCE(SUM((pricing->>'total')::numeric),  0)::float  AS total_revenue,
         COALESCE(COUNT(*), 0)::int                              AS total_orders,
         COALESCE(AVG((pricing->>'total')::numeric),  0)::float  AS avg_order_value,
         COALESCE(SUM((pricing->>'discount')::numeric), 0)::float AS total_discount
       FROM store.orders ${where}`,
      params,
    )

    return successResponse({
      totalRevenue:  +((row?.total_revenue   ?? 0)).toFixed(2),
      totalOrders:      row?.total_orders    ?? 0,
      avgOrderValue: +((row?.avg_order_value ?? 0)).toFixed(2),
      totalDiscount: +((row?.total_discount  ?? 0)).toFixed(2),
      period: { from: from ?? 'all', to: to ?? 'all' },
    })
  }

  @Get('revenue-by-day')
  @ApiOperation({ summary: '[Admin] Daily revenue for last N days' })
  @ApiQuery({ name: 'days', required: false, description: 'Default 30, max 365' })
  async revenueByDay(@Query('days') days?: string) {
    const d    = Math.min(365, Math.max(1, Number(days ?? 30)))
    const from = new Date(Date.now() - d * 86_400_000)

    const rows = await this.db.query<any>(
      `SELECT
         TO_CHAR(created_at, 'YYYY-MM-DD')           AS date,
         COALESCE(SUM((pricing->>'total')::numeric), 0)::float AS revenue,
         COUNT(*)::int                                           AS orders
       FROM store.orders
       WHERE created_at >= $1 AND status NOT IN ('cancelled')
       GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
       ORDER BY date ASC`,
      [from],
    )

    return successResponse(rows.map(r => ({
      date:    r.date,
      revenue: +(r.revenue ?? 0).toFixed(2),
      orders:  r.orders,
    })))
  }

  @Get('top-products')
  @ApiOperation({ summary: '[Admin] Top selling products by revenue' })
  @ApiQuery({ name: 'limit', required: false })
  async topProducts(@Query('limit') limit?: string) {
    const l = Math.min(50, Math.max(1, Number(limit ?? 10)))

    // items is a JSONB array: [{asin, title, quantity, subtotal, ...}]
    const rows = await this.db.query<any>(
      `SELECT
         item->>'asin'                                                  AS asin,
         (item->>'title')                                               AS title,
         SUM((item->>'subtotal')::numeric)::float                       AS revenue,
         SUM((item->>'quantity')::int)::int                             AS units_sold,
         COUNT(DISTINCT o.order_id)::int                                AS orders
       FROM store.orders o,
            LATERAL jsonb_array_elements(o.items) AS item
       WHERE o.status NOT IN ('cancelled')
       GROUP BY item->>'asin', item->>'title'
       ORDER BY revenue DESC
       LIMIT $1`,
      [l],
    )

    return successResponse(rows.map(r => ({
      asin:      r.asin,
      title:     r.title,
      revenue:   +(r.revenue   ?? 0).toFixed(2),
      unitsSold: r.units_sold,
      orders:    r.orders,
    })))
  }

  @Get('users')
  @ApiOperation({ summary: '[Admin] User growth and registration stats' })
  async userStats() {
    const row = await this.db.queryOne<any>(
      `SELECT
         COUNT(*)::int                                       AS total,
         COUNT(*) FILTER (WHERE is_verified)::int           AS verified,
         COUNT(*) FILTER (WHERE is_active)::int             AS active,
         COUNT(*) FILTER (WHERE role = 'admin')::int        AS admins,
         COUNT(*) FILTER (WHERE NOT is_verified)::int       AS unverified
       FROM store.users`,
    )
    return successResponse(row)
  }

  @Get('orders-by-status')
  @ApiOperation({ summary: '[Admin] Order counts grouped by status' })
  async ordersByStatus() {
    const rows = await this.db.query<any>(
      `SELECT status, COUNT(*)::int AS count
       FROM store.orders GROUP BY status ORDER BY count DESC`,
    )
    const stats: Record<string, number> = {}
    let total = 0
    for (const r of rows) { stats[r.status] = r.count; total += r.count }
    return successResponse({ ...stats, total })
  }
}
