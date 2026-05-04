// src/health/health.controller.ts — PostgreSQL only, no Mongoose
import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger'
import { RequireRoleGuard }     from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }          from '../identity/guards/identity.guards'


import { successResponse }   from '../common/api-utils'
import { ProductsService }   from '../products/products.service'
import { CategoriesService } from '../categories/categories.service'
import { DatabaseService }   from '../database/database.service'

@ApiTags('Health')
@Controller('health')
export class HealthController {
  // Cache DB counts for 30 s so frequent monitor pings don't hammer Postgres
  private countCache: { data: any; expiresAt: number } | null = null

  constructor(
    private readonly productsService:   ProductsService,
    private readonly categoriesService: CategoriesService,
    private readonly db:                DatabaseService,
  ) {}

  /** Public liveness probe — safe for external monitors */
  @Get()
  @ApiOperation({ summary: 'Liveness check — public, minimal' })
  ping() {
    return successResponse({ status: 'ok', timestamp: new Date().toISOString() })
  }

  /** Admin-only readiness probe — heap, counts, env */
  @Get('detail')
  @ApiBearerAuth()
  @UseGuards(RequireRoleGuard, JitProvisioningGuard)
  @RequireRole('admin')
  @ApiOperation({ summary: '[Admin] Detailed health: heap, counts, uptime' })
  async detail() {
    const now = Date.now()

    if (!this.countCache || this.countCache.expiresAt < now) {
      const rows = await Promise.all([
        this.db.queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM store.users'),
        this.db.queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM store.orders'),
        this.db.queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM store.coupons'),
        this.db.queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM store.banners'),
      ])
      this.countCache = {
        data: {
          users:   rows[0]?.cnt ?? 0,
          orders:  rows[1]?.cnt ?? 0,
          coupons: rows[2]?.cnt ?? 0,
          banners: rows[3]?.cnt ?? 0,
        },
        expiresAt: now + 30_000,
      }
    }

    const mem = process.memoryUsage()
    return successResponse({
      status:      'ok',
      version:     '5.0.0',
      environment: process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
      uptime:      process.uptime().toFixed(2) + 's',
      timestamp:   new Date().toISOString(),
      dataLoaded: {
        products:   this.productsService.products.length,
        categories: this.categoriesService.categories.length,
        ...this.countCache.data,
      },
      memory: {
        heapUsed:  (mem.heapUsed  / 1024 / 1024).toFixed(2) + ' MB',
        heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
        rss:       (mem.rss       / 1024 / 1024).toFixed(2) + ' MB',
      },
    })
  }
}
