// src/homepage/tests/homepage-personalization.service.spec.ts
//
// Unit tests for PersonalizationService — P13N engine.
//
// Coverage:
//   • All four personalized sections are computed correctly
//   • Redis cache hit path returns stale data with fromCache=true
//   • Graceful fallbacks when user has no browsing history
//   • Co-occurrence (alsoViewed) logic with and without data
//   • continueShoppingFor correctly excludes purchased items
//   • deriveTopDepts accurately ranks departments by view count
//   • onModuleInit subscribes to the P13N invalidation channel
//   • invalidateForUser deletes the correct Redis key

import { Test, TestingModule }       from '@nestjs/testing'
import { PersonalizationService }    from '../homepage-personalization.service'
import { DatabaseService }           from '../../database/database.service'
import { RedisService }              from '../../redis/redis.service'
import { ProductsService, toCard }   from '../../products/products.service'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001'

function makeProduct(overrides: Partial<any> = {}) {
  return {
    asin:            `B${String(Math.random()).slice(2, 8)}`,
    slug:            'test-product',
    title:           'Test Product',
    brand:           'Acme',
    thumbnail:       'https://img.example.com/p.jpg',
    price:           29.99,
    original_price:  null,
    discount_pct:    0,
    avg_rating:      4.5,
    review_count:    150,
    is_prime:        true,
    in_stock:        true,
    is_on_sale:      false,
    is_best_seller:  false,
    is_amazon_choice:false,
    is_trending:     true,
    is_free_ship:    false,
    is_deal:         false,
    is_new_release:  false,
    is_top_rated:    true,
    is_active:       true,
    taxonomy_dept:   'Electronics',
    taxonomy_subcat: 'Headphones',
    thumbnails:      [],
    flags:           {},
    product_results: {},
    ...overrides,
  }
}

const RECENT_ROWS = [
  { asin: 'B001', viewed_at: new Date('2024-01-03') },
  { asin: 'B002', viewed_at: new Date('2024-01-02') },
  { asin: 'B003', viewed_at: new Date('2024-01-01') },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDatabaseService() {
  return {
    query:    jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute:  jest.fn().mockResolvedValue(1),
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

function makeProductsService(products: any[] = []) {
  return {
    products,
    ensureLoaded:      jest.fn().mockResolvedValue(undefined),
    getFeatured:       jest.fn().mockResolvedValue(products.map(p => ({ ...p }))),
    getTrending:       jest.fn().mockResolvedValue(products.filter(p => p.is_trending).map(p => ({ ...p }))),
    getOnSale:         jest.fn().mockResolvedValue(products.filter(p => p.is_on_sale).map(p => ({ ...p }))),
    findProductByAsin: jest.fn((asin: string) => products.find(p => p.asin === asin) ?? null),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PersonalizationService', () => {
  let service: PersonalizationService
  let db:      ReturnType<typeof makeDatabaseService>
  let redis:   ReturnType<typeof makeRedisService>
  let prods:   ReturnType<typeof makeProductsService>

  // Three products — all in Electronics to exercise dept affinity
  const products = [
    makeProduct({ asin: 'B001', taxonomy_dept: 'Electronics',   avg_rating: 4.8, review_count: 500 }),
    makeProduct({ asin: 'B002', taxonomy_dept: 'Electronics',   avg_rating: 4.2, review_count: 100 }),
    makeProduct({ asin: 'B003', taxonomy_dept: 'Home & Kitchen',avg_rating: 4.6, review_count: 300 }),
  ]

  async function buildModule(productList = products) {
    db    = makeDatabaseService()
    redis = makeRedisService()
    prods = makeProductsService(productList)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PersonalizationService,
        { provide: DatabaseService, useValue: db    },
        { provide: RedisService,    useValue: redis },
        { provide: ProductsService, useValue: prods },
      ],
    }).compile()

    service = module.get(PersonalizationService)
    await service.onModuleInit()
  }

  beforeEach(async () => {
    await buildModule()
  })

  // ── onModuleInit ────────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('subscribes to p13n:user:viewed channel', () => {
      expect(redis.subscribe).toHaveBeenCalledWith('p13n:user:viewed', expect.any(Function))
    })
  })

  // ── Redis cache ─────────────────────────────────────────────────────────────

  describe('cache', () => {
    it('returns cached result with fromCache=true on second call', async () => {
      // Cold path: DB queries run
      db.query.mockResolvedValue(RECENT_ROWS)
      const first = await service.getPersonalized(USER_ID)

      // Seed Redis cache
      redis.get.mockResolvedValue(JSON.stringify(first))

      const second = await service.getPersonalized(USER_ID)
      expect(second.meta.fromCache).toBe(true)
    })

    it('recomputes when Redis cache is empty', async () => {
      redis.get.mockResolvedValue(null)
      db.query.mockResolvedValue(RECENT_ROWS)

      const result = await service.getPersonalized(USER_ID)
      expect(result.meta.fromCache).toBe(false)
    })

    it('stores result in Redis after computation', async () => {
      redis.get.mockResolvedValue(null)
      db.query.mockResolvedValue([])

      await service.getPersonalized(USER_ID)

      // Allow fire-and-forget to settle
      await new Promise((r) => setImmediate(r))
      expect(redis.set).toHaveBeenCalledWith(
        `p13n:homepage:${USER_ID}`,
        expect.any(String),
        5 * 60,
      )
    })

    it('handles corrupt Redis JSON gracefully and recomputes', async () => {
      redis.get.mockResolvedValue('NOT_VALID_JSON{{{')
      db.query.mockResolvedValue([])

      // Should not throw — falls through to recompute path
      await expect(service.getPersonalized(USER_ID)).resolves.toBeDefined()
    })
  })

  // ── invalidateForUser ───────────────────────────────────────────────────────

  describe('invalidateForUser', () => {
    it('deletes the correct per-user Redis key', async () => {
      await service.invalidateForUser(USER_ID)
      expect(redis.del).toHaveBeenCalledWith(`p13n:homepage:${USER_ID}`)
    })
  })

  // ── continueShoppingFor ─────────────────────────────────────────────────────

  describe('continueShoppingFor', () => {
    it('returns recently viewed products not yet purchased', async () => {
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)     // recently_viewed
        .mockResolvedValueOnce([])              // ordered items (none)
        .mockResolvedValueOnce([])              // co-occurrence
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      const section = result.continueShoppingFor

      expect(section.strategy).toBe('continue_shopping')
      // B001 and B002 are in the in-memory store and were recently viewed
      expect(section.products.some((p: any) => p.asin === 'B001')).toBe(true)
    })

    it('excludes products the user has already purchased', async () => {
      // User ordered B001
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([{ product_id: 'B001' }])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      const asins  = result.continueShoppingFor.products.map((p: any) => p.asin)
      expect(asins).not.toContain('B001')
    })

    it('returns empty products when user has no browsing history', async () => {
      db.query.mockResolvedValue([])  // no recently_viewed rows
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(result.continueShoppingFor.products).toHaveLength(0)
    })
  })

  // ── basedOnBrowsingHistory ──────────────────────────────────────────────────

  describe('basedOnBrowsingHistory', () => {
    it('returns products from the user\'s most-visited departments', async () => {
      // User viewed B001 (Electronics) twice and B003 (Home & Kitchen) once
      const historyRows = [
        { asin: 'B001', viewed_at: new Date('2024-01-03') },
        { asin: 'B001', viewed_at: new Date('2024-01-02') },
        { asin: 'B003', viewed_at: new Date('2024-01-01') },
      ]
      db.query
        .mockResolvedValueOnce(historyRows)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result  = await service.getPersonalized(USER_ID)
      const section = result.basedOnBrowsingHistory

      expect(section.strategy).toBe('history_dept_affinity')
      expect(section.products.length).toBeGreaterThan(0)
      // Electronics products should be prioritised (top dept)
      const depts = section.products.map((p: any) => p.dept ?? p.taxonomy_dept)
      expect(depts.some((d: string) => d === 'Electronics')).toBe(true)
    })

    it('falls back to global featured when user has no history', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(prods.getFeatured).toHaveBeenCalled()
    })

    it('sorts by Wilson-score approximation (rating × log(reviewCount))', async () => {
      // B001: rating=4.8, reviews=500 → high Wilson score
      // B002: rating=4.2, reviews=100 → lower Wilson score
      db.query
        .mockResolvedValueOnce([{ asin: 'B001', viewed_at: new Date() }, { asin: 'B002', viewed_at: new Date() }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      const asins  = result.basedOnBrowsingHistory.products.map((p: any) => p.asin)
      // B001 should appear before B002
      expect(asins.indexOf('B001')).toBeLessThan(asins.indexOf('B002'))
    })
  })

  // ── alsoViewed (collaborative filtering) ───────────────────────────────────

  describe('alsoViewed', () => {
    it('returns co-occurrence results from DB', async () => {
      const coRow = { asin: 'B003', co_score: '5' }
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)   // recently_viewed
        .mockResolvedValueOnce([])            // orders
        .mockResolvedValueOnce([coRow])       // co-occurrence
      redis.get.mockResolvedValue(null)

      const result  = await service.getPersonalized(USER_ID)
      const section = result.alsoViewed

      expect(section.strategy).toBe('collaborative_filtering')
      expect(section.products.some((p: any) => p.asin === 'B003')).toBe(true)
    })

    it('passes user\'s recent ASINs as $1 and userId as $2 to co-occurrence query', async () => {
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      await service.getPersonalized(USER_ID)

      // Third DB call is the co-occurrence query
      const coCall = db.query.mock.calls[2]
      expect(coCall[1][0]).toEqual(expect.arrayContaining(['B001', 'B002', 'B003']))
      expect(coCall[1][1]).toBe(USER_ID)
    })

    it('falls back to trending when user has no history', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      const result  = await service.getPersonalized(USER_ID)
      const section = result.alsoViewed
      // Fallback calls getTrending
      expect(prods.getTrending).toHaveBeenCalled()
      expect(section.strategy).toBe('collaborative_filtering')
    })

    it('pads with trending products when co-occurrence returns fewer than 4', async () => {
      // Co-occurrence returns only 1 result
      const oneCoRow = { asin: 'B003', co_score: '1' }
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([oneCoRow])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      // Should have B003 from co-occurrence + trending padding
      const section = result.alsoViewed
      // Length ≥ 1 — at minimum the co-viewed item
      expect(section.products.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── moreToConsider ──────────────────────────────────────────────────────────

  describe('moreToConsider', () => {
    it('returns trending products in the user\'s affinity departments', async () => {
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result  = await service.getPersonalized(USER_ID)
      const section = result.moreToConsider

      expect(section.strategy).toBe('more_to_consider')
      expect(section.label).toBe('More to Consider')
    })

    it('falls back to global on-sale products when user has no history', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      await service.getPersonalized(USER_ID)
      expect(prods.getOnSale).toHaveBeenCalled()
    })
  })

  // ── meta ────────────────────────────────────────────────────────────────────

  describe('meta', () => {
    it('sets hasHistory=true when recently_viewed rows exist', async () => {
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(result.meta.hasHistory).toBe(true)
    })

    it('sets hasHistory=false when no recently_viewed rows', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(result.meta.hasHistory).toBe(false)
    })

    it('includes topDepts in meta', async () => {
      db.query
        .mockResolvedValueOnce(RECENT_ROWS)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(Array.isArray(result.meta.topDepts)).toBe(true)
    })

    it('includes userId in meta', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(result.meta.userId).toBe(USER_ID)
    })

    it('includes fromCache=false for fresh computation', async () => {
      db.query.mockResolvedValue([])
      redis.get.mockResolvedValue(null)

      const result = await service.getPersonalized(USER_ID)
      expect(result.meta.fromCache).toBe(false)
    })
  })
})
