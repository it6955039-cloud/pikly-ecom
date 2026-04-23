// src/homepage/tests/homepage-widgets.service.spec.ts
//
// Unit tests for HomepageWidgetsService — widget slot resolution engine.
//
// Testing strategy:
//   • All DB and service dependencies are mocked — no real DB or Redis needed.
//   • Each resolver path (hero_banner, product_carousel, category_grid,
//     dept_spotlight, campaign) is exercised in isolation.
//   • Cache behaviour (hit + miss), pub/sub invalidation, and admin CRUD
//     correctness are all verified.

import { Test, TestingModule }     from '@nestjs/testing'
import { NotFoundException }       from '@nestjs/common'
import { HomepageWidgetsService }  from '../homepage-widgets.service'
import { DatabaseService }         from '../../database/database.service'
import { CacheService }            from '../../common/cache.service'
import { RedisService }            from '../../redis/redis.service'
import { ProductsService }         from '../../products/products.service'
import { CategoriesService }       from '../../categories/categories.service'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WIDGET_ROW = {
  id:         'hw_test',
  type:       'product_carousel',
  title:      'Test Carousel',
  subtitle:   null,
  badge:      null,
  config:     { strategy: 'featured', limit: 4 },
  position:   1,
  is_active:  true,
  target:     'all',
  created_at: new Date(),
  updated_at: new Date(),
}

const BANNER_ROW = {
  id:        'ban_1',
  title:     'Mother\'s Day',
  image:     'https://cdn.example.com/banner.jpg',
  position:  'hero',
  is_active: true,
  sort_order: 0,
}

const PRODUCT = {
  asin:           'B001',
  slug:           'widget-b001',
  title:          'Widget Pro',
  brand:          'Acme',
  thumbnail:      'https://img.example.com/b001.jpg',
  price:          29.99,
  original_price: null,
  discount_pct:   0,
  avg_rating:     4.5,
  review_count:   200,
  is_prime:       true,
  in_stock:       true,
  is_on_sale:     false,
  is_best_seller: true,
  is_amazon_choice: false,
  is_trending:    false,
  is_free_ship:   false,
  is_deal:        false,
  is_new_release: false,
  is_top_rated:   true,
  is_active:      true,
  taxonomy_dept:  'Electronics',
  taxonomy_subcat:'Headphones',
  thumbnails:     [],
  flags:          {},
  product_results:{},
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDatabaseService() {
  return {
    query:    jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute:  jest.fn().mockResolvedValue(1),
    transaction: jest.fn().mockImplementation(async (fn: any) =>
      fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    ),
  }
}

function makeCacheService() {
  const store = new Map<string, any>()
  return {
    get:   jest.fn((key: string) => store.get(key) ?? null),
    set:   jest.fn((key: string, val: any) => store.set(key, val)),
    del:   jest.fn((key: string) => store.delete(key)),
    keys:  jest.fn(() => [...store.keys()]),
    flush: jest.fn(() => store.clear()),
    _store: store,  // test access
  }
}

function makeRedisService() {
  return {
    subscribe: jest.fn(),
    publish:   jest.fn().mockResolvedValue(undefined),
    del:       jest.fn().mockResolvedValue(undefined),
    get:       jest.fn().mockResolvedValue(null),
    set:       jest.fn().mockResolvedValue(undefined),
  }
}

function makeProductsService(products: any[] = [PRODUCT]) {
  return {
    products,
    ensureLoaded:         jest.fn().mockResolvedValue(undefined),
    getFeatured:          jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getBestSellers:       jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getTrending:          jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getNewArrivals:       jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getOnSale:            jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getTopRated:          jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getByDept:            jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    findProductByAsin:    jest.fn((asin: string) => products.find(p => p.asin === asin) ?? null),
  }
}

function makeCategoriesService() {
  return {
    categories:   [],
    ensureLoaded: jest.fn().mockResolvedValue(undefined),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HomepageWidgetsService', () => {
  let service: HomepageWidgetsService
  let db:      ReturnType<typeof makeDatabaseService>
  let cache:   ReturnType<typeof makeCacheService>
  let redis:   ReturnType<typeof makeRedisService>
  let prods:   ReturnType<typeof makeProductsService>
  let cats:    ReturnType<typeof makeCategoriesService>

  beforeEach(async () => {
    db    = makeDatabaseService()
    cache = makeCacheService()
    redis = makeRedisService()
    prods = makeProductsService()
    cats  = makeCategoriesService()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HomepageWidgetsService,
        { provide: DatabaseService,    useValue: db    },
        { provide: CacheService,       useValue: cache },
        { provide: RedisService,       useValue: redis },
        { provide: ProductsService,    useValue: prods },
        { provide: CategoriesService,  useValue: cats  },
      ],
    }).compile()

    service = module.get(HomepageWidgetsService)
    // Simulate onModuleInit (subscribes to Redis)
    await service.onModuleInit()
  })

  // ── onModuleInit ────────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('subscribes to homepage:invalidate channel', () => {
      expect(redis.subscribe).toHaveBeenCalledWith('homepage:invalidate', expect.any(Function))
    })
  })

  // ── getActiveWidgets ────────────────────────────────────────────────────────

  describe('getActiveWidgets', () => {
    it('returns resolved widgets from DB when cache is cold', async () => {
      db.query.mockResolvedValueOnce([WIDGET_ROW])

      const result = await service.getActiveWidgets(false)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('hw_test')
      expect(result[0].type).toBe('product_carousel')
      expect(result[0].data).toHaveProperty('products')
    })

    it('returns cached result without hitting DB on second call', async () => {
      db.query.mockResolvedValue([WIDGET_ROW])

      await service.getActiveWidgets(false)
      const dbCallCount = db.query.mock.calls.length

      await service.getActiveWidgets(false)
      // DB call count should not increase (cache hit)
      expect(db.query.mock.calls.length).toBe(dbCallCount)
    })

    it('filters out target=authenticated widgets for anonymous users', async () => {
      const authWidget = { ...WIDGET_ROW, id: 'hw_auth', target: 'authenticated' }
      db.query.mockResolvedValue([WIDGET_ROW, authWidget])

      const result = await service.getActiveWidgets(false)
      expect(result.every((w) => w.id !== 'hw_auth')).toBe(true)
    })

    it('includes target=authenticated widgets for authenticated users', async () => {
      const authWidget = { ...WIDGET_ROW, id: 'hw_auth', target: 'authenticated' }
      db.query.mockResolvedValue([WIDGET_ROW, authWidget])

      const result = await service.getActiveWidgets(true)
      expect(result.some((w) => w.id === 'hw_auth')).toBe(true)
    })

    it('filters out target=anonymous widgets for authenticated users', async () => {
      const anonWidget = { ...WIDGET_ROW, id: 'hw_anon', target: 'anonymous' }
      db.query.mockResolvedValue([WIDGET_ROW, anonWidget])

      const result = await service.getActiveWidgets(true)
      expect(result.every((w) => w.id !== 'hw_anon')).toBe(true)
    })

    it('does not throw when a single widget resolver fails — returns remaining widgets', async () => {
      const badWidget = { ...WIDGET_ROW, id: 'hw_bad', type: 'product_carousel' }
      db.query.mockResolvedValue([badWidget, WIDGET_ROW])
      prods.getFeatured
        .mockRejectedValueOnce(new Error('resolver failure'))  // first call fails
        .mockResolvedValue([PRODUCT])                          // second call succeeds

      const result = await service.getActiveWidgets(false)
      // The bad widget is silently dropped — the good one still returns
      expect(result.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Widget resolvers ────────────────────────────────────────────────────────

  describe('hero_banner resolver', () => {
    it('fetches banners filtered by position', async () => {
      const heroBannerWidget = {
        ...WIDGET_ROW,
        type:   'hero_banner',
        config: { bannerPosition: 'hero' },
      }
      db.query
        .mockResolvedValueOnce([heroBannerWidget])  // raw widgets
        .mockResolvedValueOnce([BANNER_ROW])         // banners query

      const result = await service.getActiveWidgets(false)
      const widget = result.find((w) => w.type === 'hero_banner')

      expect(widget).toBeDefined()
      expect(widget!.data.banners).toHaveLength(1)
      expect(widget!.data.bannerPosition).toBe('hero')
    })

    it('includes start_date / end_date filtering in the banner query', async () => {
      const heroBannerWidget = { ...WIDGET_ROW, type: 'hero_banner', config: { bannerPosition: 'hero' } }
      db.query.mockResolvedValueOnce([heroBannerWidget]).mockResolvedValueOnce([])

      await service.getActiveWidgets(false)

      const bannerQuery: string = db.query.mock.calls[1][0]
      // Query must filter for active, date-range valid banners
      expect(bannerQuery).toContain('is_active = true')
      expect(bannerQuery).toContain('start_date')
      expect(bannerQuery).toContain('end_date')
    })
  })

  describe('product_carousel resolver', () => {
    const strategies = [
      ['featured',    'getFeatured'],
      ['bestsellers', 'getBestSellers'],
      ['trending',    'getTrending'],
      ['new_arrivals','getNewArrivals'],
      ['on_sale',     'getOnSale'],
      ['top_rated',   'getTopRated'],
    ] as const

    it.each(strategies)('strategy=%s calls ProductsService.%s', async (strategy, method) => {
      const widget = { ...WIDGET_ROW, config: { strategy, limit: 4 } }
      db.query.mockResolvedValue([widget])

      await service.getActiveWidgets(false)
      expect((prods as any)[method]).toHaveBeenCalledWith(4)
    })

    it('strategy=by_dept calls getByDept with the configured dept', async () => {
      const widget = { ...WIDGET_ROW, config: { strategy: 'by_dept', dept: 'Electronics', limit: 6 } }
      db.query.mockResolvedValue([widget])

      await service.getActiveWidgets(false)
      expect(prods.getByDept).toHaveBeenCalledWith('Electronics', 6)
    })

    it('strategy=by_dept with missing dept returns empty products without throwing', async () => {
      const widget = { ...WIDGET_ROW, config: { strategy: 'by_dept', limit: 6 } }
      db.query.mockResolvedValue([widget])

      const result = await service.getActiveWidgets(false)
      const w = result.find((x) => x.id === widget.id)
      expect(w!.data.products).toEqual([])
    })

    it('caps limit at 50', async () => {
      const widget = { ...WIDGET_ROW, config: { strategy: 'featured', limit: 999 } }
      db.query.mockResolvedValue([widget])

      await service.getActiveWidgets(false)
      expect(prods.getFeatured).toHaveBeenCalledWith(50)
    })
  })

  describe('category_grid resolver', () => {
    it('groups products by subcategory into cells', async () => {
      const widget = { ...WIDGET_ROW, type: 'category_grid', config: { limit: 4, productsPerCell: 1 } }
      db.query.mockResolvedValue([widget])

      const result = await service.getActiveWidgets(false)
      const w = result.find((x) => x.id === widget.id)

      expect(w!.data.cells).toBeDefined()
      expect(Array.isArray(w!.data.cells)).toBe(true)
    })

    it('filters by maxPrice when configured', async () => {
      const cheapProduct  = { ...PRODUCT, asin: 'B002', price: 10 }
      const expensiveProduct = { ...PRODUCT, asin: 'B003', price: 100 }
      prods.products = [cheapProduct, expensiveProduct]

      const widget = {
        ...WIDGET_ROW,
        type:   'category_grid',
        config: { maxPrice: 50, limit: 4, productsPerCell: 2 },
      }
      db.query.mockResolvedValue([widget])

      const result = await service.getActiveWidgets(false)
      const w = result.find((x) => x.id === widget.id)

      // All product thumbnails in cells should belong to the cheap product
      const allAsins = w!.data.cells.flatMap((c: any) => c.products.map((p: any) => p.asin))
      expect(allAsins).not.toContain('B003')
    })
  })

  describe('dept_spotlight resolver', () => {
    it('returns products for the configured department', async () => {
      const widget = { ...WIDGET_ROW, type: 'dept_spotlight', config: { dept: 'Electronics', limit: 4 } }
      db.query.mockResolvedValue([widget])

      await service.getActiveWidgets(false)
      expect(prods.getByDept).toHaveBeenCalledWith('Electronics', 4)
    })

    it('returns empty products without throwing when dept is missing from config', async () => {
      const widget = { ...WIDGET_ROW, type: 'dept_spotlight', config: {} }
      db.query.mockResolvedValue([widget])

      const result = await service.getActiveWidgets(false)
      const w = result.find((x) => x.id === widget.id)
      expect(w!.data.products).toEqual([])
    })
  })

  // ── Admin CRUD ──────────────────────────────────────────────────────────────

  describe('adminCreate', () => {
    it('inserts a row and publishes invalidation', async () => {
      const newRow = { ...WIDGET_ROW, id: 'hw_new' }
      db.queryOne.mockResolvedValue(newRow)

      const result = await service.adminCreate({
        type:   'product_carousel',
        config: { strategy: 'trending', limit: 8 },
      })

      expect(db.queryOne).toHaveBeenCalled()
      expect(redis.publish).toHaveBeenCalledWith('homepage:invalidate', expect.any(String))
      expect(result.id).toBe('hw_new')
    })
  })

  describe('adminUpdate', () => {
    it('updates the row and invalidates cache', async () => {
      const updated = { ...WIDGET_ROW, title: 'Updated Title' }
      db.queryOne.mockResolvedValue(updated)

      const result = await service.adminUpdate('hw_test', { title: 'Updated Title' })

      expect(result.title).toBe('Updated Title')
      expect(redis.publish).toHaveBeenCalledWith('homepage:invalidate', expect.any(String))
    })

    it('throws NotFoundException when widget does not exist', async () => {
      db.queryOne.mockResolvedValue(null)

      await expect(service.adminUpdate('hw_ghost', { title: 'x' })).rejects.toThrow(NotFoundException)
    })
  })

  describe('adminDelete', () => {
    it('deletes the widget and returns { deleted: true }', async () => {
      db.execute.mockResolvedValue(1)

      const result = await service.adminDelete('hw_test')
      expect(result).toEqual({ deleted: true })
      expect(redis.publish).toHaveBeenCalled()
    })

    it('throws NotFoundException when no row is affected', async () => {
      db.execute.mockResolvedValue(0)

      await expect(service.adminDelete('hw_ghost')).rejects.toThrow(NotFoundException)
    })
  })

  describe('adminReorder', () => {
    it('runs position updates inside a transaction', async () => {
      const txClient = { query: jest.fn().mockResolvedValue({ rows: [] }) }
      db.transaction.mockImplementation(async (fn: any) => fn(txClient))

      const result = await service.adminReorder({ ids: ['hw_a', 'hw_b', 'hw_c'] })

      expect(db.transaction).toHaveBeenCalled()
      // 3 ids → 3 UPDATE calls inside the transaction
      expect(txClient.query).toHaveBeenCalledTimes(3)
      expect(result).toEqual({ reordered: 3 })
    })

    it('assigns position = array index', async () => {
      const txClient = { query: jest.fn().mockResolvedValue({ rows: [] }) }
      db.transaction.mockImplementation(async (fn: any) => fn(txClient))

      await service.adminReorder({ ids: ['hw_a', 'hw_b'] })

      // First call: position=0 for 'hw_a'
      expect(txClient.query.mock.calls[0][1]).toEqual([0, 'hw_a'])
      // Second call: position=1 for 'hw_b'
      expect(txClient.query.mock.calls[1][1]).toEqual([1, 'hw_b'])
    })
  })

  describe('adminToggle', () => {
    it('flips is_active to false when currently true', async () => {
      db.queryOne
        .mockResolvedValueOnce({ ...WIDGET_ROW, is_active: true })   // SELECT for current state
        .mockResolvedValueOnce({ ...WIDGET_ROW, is_active: false })   // UPDATE RETURNING

      const result = await service.adminToggle('hw_test')
      expect(result.is_active).toBe(false)
    })
  })
})
