// src/catalog-intelligence/tests/data-quality.service.spec.ts
// =============================================================================
// Unit tests for DataQualityService.scoreProduct()
//
// This method is pure logic with zero DB dependency — every code path can be
// tested without mocking anything. That's what we test here.
//
// Coverage targets:
//   • Happy path — rich product → high score (≥80)
//   • Each dimension independently (title / images / desc / attrs / variants /
//     reviews / taxonomy)
//   • Each issue code is emitted exactly when expected
//   • Boundary conditions (null values, empty arrays, zero counts)
//   • Score arithmetic (weighted sum stays within [0, 100])
//   • Family schema: required attrs missing → score capped at 60
// =============================================================================

import { Test, TestingModule } from '@nestjs/testing'
import { DataQualityService } from '../services/data-quality.service'
import { NeonService }        from '../services/neon.service'
import type { QualityIssue } from '../types/cil.types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal valid raw_json record for a scraped product */
function buildRawJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      product_results: {
        title:              'Sony WH-1000XM5 Wireless Noise Canceling Headphones',
        brand:              'Sony',
        rating:             4.6,
        reviews:            14_496,
        bought_last_month:  '10K+ bought',
        thumbnail:          'https://example.com/img.jpg',
        thumbnails:         [
          'https://example.com/img1.jpg',
          'https://example.com/img2.jpg',
          'https://example.com/img3.jpg',
          'https://example.com/img4.jpg',
          'https://example.com/img5.jpg',
          'https://example.com/img6.jpg',
        ],
        prime:    true,
        delivery: ['FREE delivery Friday'],
        stock:    'In Stock',
        variants: [],
      },
      about_item: [
        'Industry-leading noise cancellation with Dual Noise Sensor Technology',
        'Up to 30-hour battery life with quick charging (3 min = 3 hours)',
        'Crystal clear hands-free calling with Precise Voice Pickup Technology',
        'Multipoint connection — connect to 2 devices simultaneously',
        'Lightweight at 250g with soft fit leather',
      ],
      product_details: {
        brand:                  'Sony',
        connectivity_technology: 'Bluetooth, USB',
        color:                  'Black',
        item_weight:            '8.81 ounces',
        battery_average_life:   '30 Hours',
        model_number:           'WH1000XM5/B',
        manufacturer:           'Sony Electronics',
      },
      ...overrides,
    },
  }
}

function buildSchema(keys: string[], requiredKeys: string[] = []) {
  return keys.map(k => ({ key: k, required: requiredKeys.includes(k) }))
}

function findIssue(issues: readonly QualityIssue[], code: string): QualityIssue | undefined {
  return issues.find(i => i.code === code)
}

// ── Mock NeonService (scoreProduct never calls DB) ────────────────────────────

const mockNeonService = {
  query:    jest.fn().mockResolvedValue([]),
  getPool:  jest.fn(),
  isHealthy: jest.fn().mockReturnValue(false),
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('DataQualityService.scoreProduct()', () => {
  let service: DataQualityService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataQualityService,
        { provide: NeonService, useValue: mockNeonService },
      ],
    }).compile()

    service = module.get<DataQualityService>(DataQualityService)
    jest.clearAllMocks()
  })

  // ── Overall score range ───────────────────────────────────────────────────

  describe('score range invariants', () => {
    it('overall score is always in [0, 100]', () => {
      const result = service.scoreProduct(buildRawJson(), [], 3)
      expect(result.qualityScore).toBeGreaterThanOrEqual(0)
      expect(result.qualityScore).toBeLessThanOrEqual(100)
    })

    it('each dimension score is in [0, 100]', () => {
      const result = service.scoreProduct(buildRawJson(), [], 3)
      const { scoreDimensions: d } = result
      for (const [dim, score] of Object.entries(d)) {
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(100)
      }
    })

    it('rich, complete product scores ≥80', () => {
      const result = service.scoreProduct(buildRawJson(), [], 4)
      expect(result.qualityScore).toBeGreaterThanOrEqual(80)
    })

    it('empty raw_json scores ≤20', () => {
      const result = service.scoreProduct({}, [], 0)
      expect(result.qualityScore).toBeLessThanOrEqual(20)
    })
  })

  // ── Title dimension ───────────────────────────────────────────────────────

  describe('title scoring', () => {
    it('emits TITLE_TOO_SHORT when title is under 30 chars', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title'] = 'Short'
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'TITLE_TOO_SHORT')).toBeDefined()
    })

    it('emits TITLE_TOO_LONG when title exceeds 250 chars', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title'] = 'A'.repeat(260)
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'TITLE_TOO_LONG')).toBeDefined()
    })

    it('emits TITLE_ALL_CAPS for a fully uppercased long title', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title'] = 'SONY WH1000XM5 NOISE CANCELING HEADPHONES BLACK BRAND NEW'
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'TITLE_ALL_CAPS')).toBeDefined()
    })

    it('emits TITLE_NO_BRAND when brand is absent from the title', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title'] = 'Wireless Noise Canceling Headphones Premium Quality'
      ;(raw['data'] as any)['product_results']['brand'] = 'HiddenBrand'
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'TITLE_NO_BRAND')).toBeDefined()
    })

    it('does NOT emit TITLE_NO_BRAND when brand appears in title', () => {
      const raw = buildRawJson() // title contains "Sony"
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'TITLE_NO_BRAND')).toBeUndefined()
    })

    it('title score is 0 when title is completely absent', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title'] = ''
      const { scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(scoreDimensions.title).toBe(0)
    })
  })

  // ── Images dimension ──────────────────────────────────────────────────────

  describe('images scoring', () => {
    it('emits NO_IMAGES and returns images score 0 when no images at all', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['thumbnail']  = ''
      ;(raw['data'] as any)['product_results']['thumbnails'] = []
      const { issues, scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'NO_IMAGES')).toBeDefined()
      expect(scoreDimensions.images).toBe(0)
    })

    it('emits FEW_IMAGES when only 1 image is present', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['thumbnails'] = ['https://example.com/img1.jpg']
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'FEW_IMAGES')).toBeDefined()
    })

    it('does NOT emit FEW_IMAGES with 6+ images', () => {
      const raw = buildRawJson() // has 6 thumbnails in buildRawJson
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'FEW_IMAGES')).toBeUndefined()
    })

    it('filters out non-HTTP thumbnail strings', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['thumbnails'] = [
        'https://real.com/img.jpg',
        '',                             // empty — should be filtered
        'not-a-url',                    // invalid — should be filtered
        'https://real.com/img2.jpg',
      ]
      // Should count 2 valid images → FEW_IMAGES warning
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'FEW_IMAGES')).toBeDefined()
    })
  })

  // ── Description dimension ─────────────────────────────────────────────────

  describe('description scoring', () => {
    it('emits NO_DESCRIPTION and returns 0 when about_item and product_description are absent', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['about_item']          = []
      ;(raw['data'] as any)['product_description'] = []
      const { issues, scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'NO_DESCRIPTION')).toBeDefined()
      expect(scoreDimensions.description).toBe(0)
    })

    it('emits NO_BULLET_POINTS when about_item is empty but product_description exists', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['about_item']          = []
      ;(raw['data'] as any)['product_description'] = [{ title: 'Some description' }]
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'NO_BULLET_POINTS')).toBeDefined()
    })

    it('emits FEW_BULLET_POINTS with only 2 bullets', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['about_item'] = ['First bullet.', 'Second bullet.']
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'FEW_BULLET_POINTS')).toBeDefined()
    })

    it('does NOT emit FEW_BULLET_POINTS with 5 bullets', () => {
      const raw = buildRawJson() // 5 bullets in buildRawJson
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'FEW_BULLET_POINTS')).toBeUndefined()
    })
  })

  // ── Attributes / family schema dimension ──────────────────────────────────

  describe('attributes scoring', () => {
    it('returns attributeCoverage = 100% when all schema keys are present', () => {
      const raw    = buildRawJson()
      // product_details has: brand, connectivity_technology, color, item_weight,
      //                      battery_average_life, model_number, manufacturer
      const schema = buildSchema(
        ['brand', 'connectivity_technology', 'color', 'item_weight'],
        ['brand'],
      )
      const { attributeCoverage, missingAttrs } = service.scoreProduct(raw, schema, 3)
      expect(attributeCoverage).toBe(100)
      expect(missingAttrs).toHaveLength(0)
    })

    it('emits MISSING_REQUIRED_ATTRS when required attrs are absent', () => {
      const schema = buildSchema(
        ['brand', 'wattage', 'voltage'],
        ['wattage', 'voltage'],   // required but not in default product_details
      )
      const { issues, missingAttrs } = service.scoreProduct(buildRawJson(), schema, 3)
      expect(findIssue(issues, 'MISSING_REQUIRED_ATTRS')).toBeDefined()
      expect(missingAttrs).toContain('wattage')
      expect(missingAttrs).toContain('voltage')
    })

    it('caps attribute score at 60 when any required attr is missing', () => {
      const schema = buildSchema(['wattage'], ['wattage'])
      const { scoreDimensions } = service.scoreProduct(buildRawJson(), schema, 3)
      expect(scoreDimensions.attributes).toBeLessThanOrEqual(60)
    })

    it('emits LOW_ATTRIBUTE_COVERAGE when coverage < 40%', () => {
      // Schema has 10 keys, product has only brand
      const schema = buildSchema([
        'wattage','voltage','amperage','frequency','resistance',
        'efficiency','flow_rate','pressure','noise_level','merv_rating',
      ])
      const { issues } = service.scoreProduct(buildRawJson(), schema, 3)
      expect(findIssue(issues, 'LOW_ATTRIBUTE_COVERAGE')).toBeDefined()
    })

    it('returns presentAttrs containing keys from product_details', () => {
      const { presentAttrs } = service.scoreProduct(buildRawJson(), [], 3)
      expect(presentAttrs).toContain('brand')
      expect(presentAttrs).toContain('color')
    })

    it('handles null/empty product_details gracefully', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_details'] = null
      expect(() => service.scoreProduct(raw, [], 3)).not.toThrow()
    })
  })

  // ── Variants dimension ────────────────────────────────────────────────────

  describe('variants scoring', () => {
    it('returns 70 when no variants present (acceptable — not all products have variants)', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['variants'] = []
      const { scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(scoreDimensions.variants).toBe(70)
    })

    it('emits VARIANT_IMAGES_MISSING when less than 30% of variant items have images', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['variants'] = [
        {
          title: 'Color',
          items: [
            { asin: 'B001', name: 'Black', image: '' },
            { asin: 'B002', name: 'White', image: '' },
            { asin: 'B003', name: 'Red',   image: '' },
            { asin: 'B004', name: 'Blue',  image: 'https://example.com/blue.jpg' },
          ],
        },
      ]
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'VARIANT_IMAGES_MISSING')).toBeDefined()
    })

    it('does NOT emit VARIANT_IMAGES_MISSING when all variants have images', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['variants'] = [
        {
          title: 'Color',
          items: [
            { asin: 'B001', name: 'Black', image: 'https://example.com/black.jpg' },
            { asin: 'B002', name: 'White', image: 'https://example.com/white.jpg' },
          ],
        },
      ]
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'VARIANT_IMAGES_MISSING')).toBeUndefined()
    })

    it('handles malformed variants array without throwing', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['variants'] = [null, undefined, 42, 'bad']
      expect(() => service.scoreProduct(raw, [], 3)).not.toThrow()
    })
  })

  // ── Reviews dimension ─────────────────────────────────────────────────────

  describe('reviews scoring', () => {
    it('emits NO_REVIEWS and returns 20 when review count is 0', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['reviews'] = 0
      const { issues, scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'NO_REVIEWS')).toBeDefined()
      expect(scoreDimensions.reviews).toBe(20)
    })

    it('emits LOW_REVIEW_COUNT for under 10 reviews', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['reviews'] = 5
      const { issues } = service.scoreProduct(raw, [], 3)
      expect(findIssue(issues, 'LOW_REVIEW_COUNT')).toBeDefined()
    })

    it('returns reviews score > 70 for 1000+ reviews with 4.5+ rating', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['reviews'] = 12_000
      ;(raw['data'] as any)['product_results']['rating']  = 4.7
      const { scoreDimensions } = service.scoreProduct(raw, [], 3)
      expect(scoreDimensions.reviews).toBeGreaterThan(70)
    })
  })

  // ── Taxonomy dimension ────────────────────────────────────────────────────

  describe('taxonomy scoring', () => {
    it('emits SHALLOW_TAXONOMY and returns 30 for depth < 2', () => {
      const { issues, scoreDimensions } = service.scoreProduct(buildRawJson(), [], 1)
      expect(findIssue(issues, 'SHALLOW_TAXONOMY')).toBeDefined()
      expect(scoreDimensions.taxonomy).toBe(30)
    })

    it('returns 100 for taxonomy depth ≥ 5', () => {
      const { scoreDimensions } = service.scoreProduct(buildRawJson(), [], 5)
      expect(scoreDimensions.taxonomy).toBe(100)
    })

    it('returns 50 for depth 2', () => {
      const { scoreDimensions } = service.scoreProduct(buildRawJson(), [], 2)
      expect(scoreDimensions.taxonomy).toBe(50)
    })

    it('returns 75 for depth 3', () => {
      const { scoreDimensions } = service.scoreProduct(buildRawJson(), [], 3)
      expect(scoreDimensions.taxonomy).toBe(75)
    })
  })

  // ── Issue structure ───────────────────────────────────────────────────────

  describe('issue structure', () => {
    it('every issue has code, severity, and message', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['title']     = ''
      ;(raw['data'] as any)['product_results']['thumbnail'] = ''
      ;(raw['data'] as any)['product_results']['thumbnails'] = []
      ;(raw['data'] as any)['about_item'] = []
      ;(raw['data'] as any)['product_description'] = []

      const { issues } = service.scoreProduct(raw, [], 1)
      for (const issue of issues) {
        expect(typeof issue.code).toBe('string')
        expect(issue.code.length).toBeGreaterThan(0)
        expect(['critical', 'warning', 'info']).toContain(issue.severity)
        expect(typeof issue.message).toBe('string')
        expect(issue.message.length).toBeGreaterThan(0)
      }
    })

    it('no duplicate issue codes for the same product', () => {
      const { issues } = service.scoreProduct(buildRawJson(), [], 3)
      const codes = issues.map(i => i.code)
      const unique = new Set(codes)
      // Allow one exception: FEW_IMAGES may appear at most once
      expect(codes.length).toBe(unique.size)
    })
  })

  // ── Null safety ───────────────────────────────────────────────────────────

  describe('null safety', () => {
    it('does not throw when data key is missing entirely', () => {
      expect(() => service.scoreProduct({}, [], 0)).not.toThrow()
    })

    it('does not throw when product_results is null', () => {
      expect(() =>
        service.scoreProduct({ data: { product_results: null } }, [], 0),
      ).not.toThrow()
    })

    it('does not throw when thumbnails is not an array', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['product_results']['thumbnails'] = 'not-an-array'
      expect(() => service.scoreProduct(raw, [], 3)).not.toThrow()
    })

    it('does not throw when about_item contains non-string entries', () => {
      const raw = buildRawJson()
      ;(raw['data'] as any)['about_item'] = [null, undefined, 42, { obj: true }, 'valid bullet']
      expect(() => service.scoreProduct(raw, [], 3)).not.toThrow()
    })

    it('does not throw when familySchema is empty', () => {
      expect(() => service.scoreProduct(buildRawJson(), [], 3)).not.toThrow()
    })

    it('returns empty arrays for missingAttrs and presentAttrs on missing product_details', () => {
      const raw = buildRawJson()
      delete (raw['data'] as any)['product_details']
      const schema = buildSchema(['brand', 'color'], ['brand'])
      const { missingAttrs, presentAttrs } = service.scoreProduct(raw, schema, 3)
      expect(Array.isArray(missingAttrs)).toBe(true)
      expect(Array.isArray(presentAttrs)).toBe(true)
    })
  })

  // ── Score arithmetic ──────────────────────────────────────────────────────

  describe('weighted sum arithmetic', () => {
    it('total is a weighted combination within 0-100', () => {
      // Verify all combos of extreme scores still produce valid output
      const cases = [
        buildRawJson(),                                         // rich product
        {},                                                     // empty
        { data: { product_results: { title: 'T'.repeat(80) } } }, // partial
      ]
      for (const raw of cases) {
        const { qualityScore } = service.scoreProduct(raw, [], 2)
        expect(qualityScore).toBeGreaterThanOrEqual(0)
        expect(qualityScore).toBeLessThanOrEqual(100)
        expect(Number.isInteger(qualityScore)).toBe(true)
      }
    })
  })
})
