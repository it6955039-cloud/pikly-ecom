/**
 * native/ranker/index.ts — TypeScript wrapper for the C++ ranking addon.
 *
 * Loads the pre-compiled native addon when available.
 * Falls back to a pure-TypeScript implementation with the same interface
 * so the app still works in environments without a C++ toolchain
 * (CI, Vercel, Netlify edge, etc.).
 *
 * Usage (NestJS):
 *   import { rankProducts, priceSort } from '../../native/ranker'
 *
 *   const ranked = await rankProducts(products, { wBestSeller: 0.15 }, 20)
 */

export interface ProductRecord {
  asin:              string
  slug:              string
  price:             number
  avg_rating:        number
  review_count:      number
  discount_pct:      number
  is_prime:          boolean
  is_best_seller:    boolean
  is_trending:       boolean
  in_stock:          boolean
  is_on_sale:        boolean
  bought_last_month?: string | null
}

export interface RankWeights {
  wRating?:     number
  wReviewLog?:  number
  wPrime?:      number
  wBestSeller?: number
  wTrending?:   number
  wInStock?:    number
  wDiscount?:   number
  wBought?:     number
}

export interface RankedProduct {
  asin:  string
  slug:  string
  score: number
}

// ── Load native addon ─────────────────────────────────────────────────────────

let native: {
  rankProducts: (products: ProductRecord[], weights: RankWeights, limit: number) => Promise<RankedProduct[]>
  priceSort:    (products: ProductRecord[], direction: number, limit: number)     => Promise<RankedProduct[]>
} | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  native = require('./build/Release/pikly_ranker')
  console.log('[ranker] C++ native addon loaded ✓')
} catch {
  console.warn('[ranker] C++ addon not available — using TypeScript fallback')
}

// ── Pure TypeScript fallback ──────────────────────────────────────────────────

function parseBLM(s: string | null | undefined): number {
  if (!s) return 0
  const upper = s.toUpperCase().replace('+', '')
  if (upper.endsWith('K')) return parseFloat(upper) * 1000
  return parseFloat(upper) || 0
}

function tsRankProducts(
  products: ProductRecord[],
  weights:  RankWeights,
  limit:    number,
): RankedProduct[] {
  const w = {
    wRating:     weights.wRating     ?? 0.35,
    wReviewLog:  weights.wReviewLog  ?? 0.20,
    wPrime:      weights.wPrime      ?? 0.10,
    wBestSeller: weights.wBestSeller ?? 0.12,
    wTrending:   weights.wTrending   ?? 0.08,
    wInStock:    weights.wInStock    ?? 0.08,
    wDiscount:   weights.wDiscount   ?? 0.07,
    wBought:     weights.wBought     ?? 0.00,
  }

  const maxReviews = Math.max(...products.map(p => p.review_count), 1)
  const logMax     = Math.log10(maxReviews + 1) || 1
  const maxBought  = Math.max(...products.map(p => parseBLM(p.bought_last_month)), 1)

  const scored = products.map(p => {
    const ratingN  = Math.min(p.avg_rating / 5.0, 1)
    const reviewN  = Math.log10(p.review_count + 1) / logMax
    const boughtN  = parseBLM(p.bought_last_month) / maxBought

    const score =
      w.wRating     * ratingN * (0.5 + 0.5 * reviewN) +
      w.wReviewLog  * reviewN +
      w.wPrime       * (p.is_prime       ? 1 : 0) +
      w.wBestSeller  * (p.is_best_seller  ? 1 : 0) +
      w.wTrending    * (p.is_trending     ? 1 : 0) +
      w.wInStock     * (p.in_stock        ? 1 : 0) +
      w.wDiscount    * Math.min(p.discount_pct / 100, 1) +
      w.wBought      * boughtN

    return { asin: p.asin, slug: p.slug, score }
  })

  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

function tsPriceSort(
  products:  ProductRecord[],
  direction: number,
  limit:     number,
): RankedProduct[] {
  return [...products]
    .sort((a, b) => {
      if (a.in_stock !== b.in_stock) return a.in_stock ? -1 : 1
      return direction >= 0 ? a.price - b.price : b.price - a.price
    })
    .slice(0, limit)
    .map(p => ({ asin: p.asin, slug: p.slug, score: p.price }))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * rankProducts — composite-score ranking.
 * Runs in a libuv worker thread (C++) or microtask (TS fallback).
 */
export async function rankProducts(
  products: ProductRecord[],
  weights:  RankWeights = {},
  limit?:   number,
): Promise<RankedProduct[]> {
  const lim = limit ?? products.length
  if (native) {
    return native.rankProducts(products, weights, lim)
  }
  return tsRankProducts(products, weights, lim)
}

/**
 * priceSort — price-ascending or price-descending sort with in-stock promotion.
 * direction: 1 = ascending (cheapest first), -1 = descending (most expensive first).
 */
export async function priceSort(
  products:  ProductRecord[],
  direction: 1 | -1 = 1,
  limit?:    number,
): Promise<RankedProduct[]> {
  const lim = limit ?? products.length
  if (native) {
    return native.priceSort(products, direction, lim)
  }
  return tsPriceSort(products, direction, lim)
}
