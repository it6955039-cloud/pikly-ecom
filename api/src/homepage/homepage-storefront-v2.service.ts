// src/homepage/homepage-storefront-v2.service.ts
//
// ═══════════════════════════════════════════════════════════════════════════════
// Pikly Storefront API v2 — Page Composition Engine
// ═══════════════════════════════════════════════════════════════════════════════
//
// BUG FIXES vs first draft:
//
//   FIX-1  CRITICAL — Double-transform bug.
//          ProductsService.getFeatured/getBestSellers/etc. all call .map(toCard)
//          which renames columns: taxonomy_dept→dept, avg_rating→avgRating,
//          is_prime→isPrime, is_amazon_choice gone, etc.
//          toCardV2() reads the original raw DB column names.
//          Fix: filter this.products.products (raw) directly — never call
//          getFeatured/getBestSellers/getTrending/etc. in this service.
//
//   FIX-2  CRITICAL — cache.getAsync returns tier:'l1'|'l2' (lowercase).
//          StorefrontMeta.cacheTier type is 'L1'|'L2'|'none' (uppercase).
//          Fix: cached.tier.toUpperCase() before storing.
//
//   FIX-3  HIGH — Banner column mapping wrong.
//          store.banners columns: id, title, subtitle, image, link, badge,
//          color, position, sort_order. No cta_text, cta_link, mobile_image,
//          desktop_image, alt_text, eyebrow columns in DB.
//          Fix: b.link→ctaLink, b.title→altText, b.badge→eyebrow.
//          mobileImage=desktopImage (single image field in schema).
//
//   FIX-4  MEDIUM — store.campaigns table does not exist.
//          fetchActiveCampaign already try/catches → returns null safely.
//          No crash. Campaigns require running sql/004_campaigns.sql first.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { CacheService, TTL }   from '../common/cache.service'
import { RedisService }        from '../redis/redis.service'
import { ProductsService }     from '../products/products.service'
import { CategoriesService }   from '../categories/categories.service'
import { DatabaseService }     from '../database/database.service'

import type {
  StorefrontV2Response, AnySection, PageContext, NavigationContext, NavDepartment,
  ProductCardV2, ProductBadge, BadgeType, StockSignal, DeliveryPromise, DealInfo,
  DealType, CategoryRank, HeroBannerSection, HeroBannerSlide, QuadMosaicRowSection,
  MosaicPanel, MosaicCell, ProductCarouselSection, CarouselStrategy, DealGridSection,
  DealCard, EditorialCampaignSection, BestsellerListSection, AlsoViewedGridSection,
  ContinueShoppingSection, BrowsingHistorySection, SubNavStripSection,
  PersonalizationBundle, RenderHints, VisibilityRules, SectionBase, CursorPage, OffsetPage,
} from './types/storefront-v2.types'

const CACHE_KEY_BASE    = 'homepage:storefront:v2:base'
const CACHE_KEY_NAV     = 'homepage:storefront:v2:nav'
const CACHE_KEY_BANNERS = 'homepage:banners:all'

const DELIVERY_DAYS   = { prime: 1, default: 3 } as const
const DAYS_OF_WEEK    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTHS          = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DEAL_REFRESH_H  = 15   // 3 PM UTC

@Injectable()
export class HomepageStorefrontV2Service implements OnModuleInit {
  private readonly logger = new Logger(HomepageStorefrontV2Service.name)
  private buildInFlight: Promise<BasePayload> | null = null

  constructor(
    private readonly db:         DatabaseService,
    private readonly cache:      CacheService,
    private readonly redis:      RedisService,
    private readonly products:   ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async onModuleInit() {
    this.redis.subscribe('homepage:invalidate', () => {
      this.cache.del(CACHE_KEY_BASE)
      this.cache.del(CACHE_KEY_NAV)
      this.cache.del(CACHE_KEY_BANNERS)
      this.logger.log('Storefront v2 cache invalidated')
    })
    this.redis.subscribe('products:invalidate', () => {
      this.cache.del(CACHE_KEY_BASE)
      this.logger.log('Storefront v2 base flushed on products:invalidate')
    })
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async getStorefrontV2(ctx: {
    userId:          string | null
    personalization: PersonalizationBundle | null
    alsoViewedPage:  number
  }): Promise<{ response: StorefrontV2Response; cacheHit: boolean; cacheTier: string }> {
    const t0 = Date.now()

    // Resolve base layout
    const cached = await this.cache.getAsync<BasePayload>(CACHE_KEY_BASE)
    let base: BasePayload
    let cacheHit  = false
    let cacheTier = 'none'

    if (cached) {
      base      = cached.value
      cacheHit  = true
      cacheTier = cached.tier.toUpperCase()   // FIX-2: lowercase 'l1'/'l2' → 'L1'/'L2'
    } else {
      if (!this.buildInFlight) {
        this.buildInFlight = this.buildBase().finally(() => { this.buildInFlight = null })
      }
      base = await this.buildInFlight
      this.cache.set(CACHE_KEY_BASE, base, TTL.STOREFRONT)
    }

    // Deep-clone — we mutate per-request for personalization
    const sections: AnySection[] = JSON.parse(JSON.stringify(base.sections))

    let personalizedCount = 0
    if (ctx.personalization) {
      personalizedCount = this.injectPersonalization(sections, ctx.personalization)
    }

    // Paginate also_viewed_grid if requested
    if (ctx.alsoViewedPage > 1) {
      const idx = sections.findIndex((s) => s.sectionId === 'also_viewed_grid')
      if (idx !== -1) {
        const updated = this.buildAlsoViewedSection(ctx.alsoViewedPage, sections[idx].position)
        if (updated) sections[idx] = updated
      }
    }

    this.stampAnalyticsTokens(sections)
    this.stampImpressionTokens(sections)

    const response: StorefrontV2Response = {
      schema: 'pikly_storefront_v2',
      page:   base.page,
      nav:    base.nav,
      sections,
      personalization: ctx.personalization,
      meta: {
        schema: 'pikly_storefront_v2', apiVersion: '2.0.0',
        generatedAt: new Date().toISOString(),
        cacheHit, cacheTier: cacheTier as 'L1' | 'L2' | 'none', cacheTtlRemaining: null,
        sectionCount: sections.length, productCount: this.countProducts(sections),
        timing: process.env.NODE_ENV !== 'production'
          ? [{ sectionId: '__total', buildMs: Date.now() - t0, strategy: 'composite' }] : null,
        personalizationContext: {
          userId: ctx.userId, isAuthenticated: !!ctx.userId,
          hasHistory: ctx.personalization?.hasHistory ?? false,
          personalizedSectionCount: personalizedCount,
        },
        featureFlags: { dealCountdownEnabled: true, editorialCampaignEnabled: true, subNavEnabled: true, quadMosaicEnabled: true },
        activeCampaignId: base.page.campaign?.id ?? null,
      },
    }

    return { response, cacheHit, cacheTier }
  }

  invalidate() {
    this.cache.del(CACHE_KEY_BASE)
    this.cache.del(CACHE_KEY_NAV)
    this.cache.del(CACHE_KEY_BANNERS)
  }

  // ── Base builder ─────────────────────────────────────────────────────────────

  private async buildBase(): Promise<BasePayload> {
    const t0 = Date.now()
    this.logger.log('Building storefront v2 base...')
    await Promise.all([this.products.ensureLoaded(), this.categories.ensureLoaded()])

    // FIX-1: Use raw product store directly. Never call getFeatured/getBestSellers/etc.
    // Those methods apply toCard() which renames all DB columns.
    // toCardV2() MUST receive raw rows with original column names.
    const raw = this.products.products.filter((p: any) => p.is_active !== false)

    const featured    = raw.filter((p: any) => p.is_amazon_choice || p.is_best_seller).sort(byRating).slice(0, 24)
    const bestsellers = raw.filter((p: any) => p.is_best_seller).sort(byRating).slice(0, 24)
    const trending    = raw.filter((p: any) => p.is_trending).sort(byRating).slice(0, 24)
    const newArrivals = raw.filter((p: any) => p.is_new_release).sort(byDate).slice(0, 24)
    const onSale      = raw.filter((p: any) => p.is_on_sale || (p.discount_pct ?? 0) >= 10).sort(byDiscount).slice(0, 24)
    const topRated    = raw.filter((p: any) => p.is_top_rated || ((p.avg_rating ?? 0) >= 4.5 && (p.review_count ?? 0) >= 100)).sort(byRating).slice(0, 24)

    const [bannerRows, activeCampaign] = await Promise.all([
      this.fetchBanners(),
      this.fetchActiveCampaign(),
    ])

    const deptMap  = buildDeptMap(raw)
    const topDepts = [...deptMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)
    const nav      = await this.buildNav(deptMap)
    const page     = this.buildPageContext(activeCampaign)

    const sections: AnySection[] = []
    let pos = 1

    sections.push(this.buildSubNavStrip(topDepts, pos++))

    const heroBanners = bannerRows.filter((b: any) => (b.position ?? 'hero') === 'hero')
    if (heroBanners.length) sections.push(this.buildHeroBanners('hero_main', heroBanners, pos++, false))

    if (activeCampaign) sections.push(this.buildEditorialCampaign(activeCampaign, pos++))

    const q1 = this.buildQuadMosaicRow('quad_row_1', topDepts.slice(0, 4), pos++, false)
    if (q1) sections.push(q1)

    if (featured.length) sections.push(this.buildCarousel('carousel_featured', "Amazon's Choice — Featured Picks", "Our editors' top picks across every department", "Amazon's Choice", '/products?featured=true', 'featured', null, featured.map((p) => this.toCardV2(p, 'carousel_featured', 'featured')), pos++, false))

    const q2 = this.buildQuadMosaicRow('quad_row_2', topDepts.slice(4, 8), pos++, false)
    if (q2) sections.push(q2)

    if (onSale.length) sections.push(this.buildDealGrid(onSale.slice(0, 12), pos++))

    if (bestsellers.length) sections.push(this.buildCarousel('carousel_bestsellers', 'Best Sellers', 'Our most popular products based on sales', '🔥 Best Sellers', '/products?bestsellers=true', 'bestsellers', null, bestsellers.map((p) => this.toCardV2(p, 'carousel_bestsellers', 'bestsellers')), pos++, false))

    if (bestsellers.length >= 4) sections.push(this.buildBestsellerList(this.findTopBestsellerCat(bestsellers), bestsellers.slice(0, 12), pos++))

    const q3 = this.buildQuadMosaicRow('quad_row_3', topDepts.slice(8, 12), pos++, true)
    if (q3) sections.push(q3)

    if (trending.length)    sections.push(this.buildCarousel('carousel_trending', 'Trending Now', "Items shoppers can't stop buying", '📈 Trending', '/products?trending=true', 'trending', null, trending.map((p) => this.toCardV2(p, 'carousel_trending', 'trending')), pos++, true))
    if (newArrivals.length) sections.push(this.buildCarousel('carousel_new_arrivals', 'New Arrivals', 'The latest additions to our catalog', '✨ New', '/products?new=true', 'new_arrivals', null, newArrivals.map((p) => this.toCardV2(p, 'carousel_new_arrivals', 'new_arrivals')), pos++, true))
    if (topRated.length)    sections.push(this.buildCarousel('carousel_top_rated', 'Top Rated', 'Loved by customers — 4.5★ and above', '⭐ Top Rated', '/products?top_rated=true', 'top_rated', null, topRated.map((p) => this.toCardV2(p, 'carousel_top_rated', 'top_rated')), pos++, true))

    // More to Consider — global fallback; personalization replaces this for auth users
    sections.push(this.buildCarousel('carousel_more_to_consider', 'More Items to Consider', 'Recommendations based on popular categories', null, '/products?trending=true', 'more_to_consider', null, trending.slice(0, 16).map((p) => this.toCardV2(p, 'carousel_more_to_consider', 'more_to_consider')), pos++, true))

    sections.push(this.buildAlsoViewedSection(1, pos++) ?? this.emptyAlsoViewed(pos - 1))
    sections.push(this.buildContinuePlaceholder(pos++))
    sections.push(this.buildHistoryPlaceholder(pos++))

    const secondary = bannerRows.filter((b: any) => b.position === 'secondary')
    if (secondary.length) sections.push(this.buildHeroBanners('banner_secondary', secondary, pos++, true))

    const result: BasePayload = { page, nav, sections: sections.sort((a, b) => a.position - b.position), nextPosition: pos }
    this.logger.log(`Storefront v2 base built: ${sections.length} sections in ${Date.now() - t0}ms`)
    return result
  }

  // ── Section builders ──────────────────────────────────────────────────────────

  private buildSubNavStrip(topDepts: [string, any[]][], position: number): SubNavStripSection {
    return {
      ...this.base('sub_nav_home', 'sub_nav_strip', null, null, null, null, position, false,
        { layout: 'strip', columns: { desktop: 1, tablet: 1, mobile: 1 }, gap: 'xs', lazy: false, showTitle: false, showSeeMore: false }),
      data: {
        links: [
          { label: 'All', link: '/products', icon: 'grid', badge: null, active: false },
          { label: "Today's Deals", link: '/products?on_sale=true', icon: 'tag', badge: 'Hot', active: false },
          ...topDepts.slice(0, 10).map(([dept]) => ({
            label: cap(dept), link: `/department/${slug(dept)}`, icon: null as string | null, badge: null as string | null, active: false,
          })),
          { label: 'Gift Cards', link: '/gift-cards', icon: 'gift', badge: null, active: false },
        ],
      },
    } as SubNavStripSection
  }

  private buildHeroBanners(id: string, rows: any[], position: number, lazy: boolean): HeroBannerSection {
    // FIX-3: Actual DB columns for store.banners:
    //   id, title, subtitle, image, link, badge, color, position, sort_order
    // Map correctly — no cta_text, mobile_image, alt_text, eyebrow columns.
    const banners: HeroBannerSlide[] = rows.map((b: any, idx: number) => ({
      id:             b.id ?? String(idx),
      position:       b.sort_order ?? idx,
      title:          b.title ?? null,
      subtitle:       b.subtitle ?? null,
      eyebrow:        b.badge ?? null,           // badge → eyebrow label
      desktopImage:   b.image ?? null,           // single image field
      mobileImage:    b.image ?? null,           // same — frontend CSS-crops for mobile
      altText:        b.title ?? 'Banner',       // title is the accessible label
      ctaText:        b.badge ? `Shop ${b.badge}` : 'Shop now',
      ctaLink:        b.link ?? null,            // b.link is the correct column name
      ctaStyle:       'primary' as const,
      textAlignment:  'left' as const,
      textColor:      'dark' as const,
      overlayOpacity: 0.05,
      badge:          b.badge ?? null,
    }))
    return {
      ...this.base(id, 'hero_banner', null, null, null, null, position, false,
        { layout: 'hero', columns: { desktop: 1, tablet: 1, mobile: 1 }, gap: 'xs', lazy, showTitle: false, showSeeMore: false, cardSize: 'lg' }),
      data: { banners, autoplayMs: 5000, aspectRatio: '21:9' as const },
    } as HeroBannerSection
  }

  private buildEditorialCampaign(campaign: RawCampaign, position: number): EditorialCampaignSection {
    return {
      ...this.base(`campaign_${campaign.id}`, 'editorial_campaign', campaign.headline, campaign.subheadline ?? null, 'Featured', `/products?campaign=${campaign.id}`, position, false,
        { layout: 'mosaic', columns: { desktop: 4, tablet: 2, mobile: 2 }, gap: 'md', lazy: false, showTitle: true, showSeeMore: true, cardSize: 'md' }),
      data: {
        campaignId: campaign.id, campaignName: campaign.name, headline: campaign.headline, subheadline: campaign.subheadline ?? null,
        backgroundImage: campaign.background_image ?? null,
        backgroundGradient: campaign.theme?.heroBackground?.startsWith('linear') ? campaign.theme.heroBackground : null,
        textColor: 'dark' as const, ctaText: `Shop ${campaign.name}`, ctaLink: `/products?campaign=${campaign.id}`,
        tiles: (campaign.tiles ?? []).map((t: any, i: number) => ({ id: t.id ?? String(i), label: t.label, image: t.image ?? null, link: t.link ?? `/products?campaign=${campaign.id}&tile=${i}`, badge: t.badge ?? null })),
      },
    } as EditorialCampaignSection
  }

  private buildQuadMosaicRow(id: string, deptEntries: [string, any[]][], position: number, lazy: boolean): QuadMosaicRowSection | null {
    const panels: MosaicPanel[] = []
    for (const [dept, deptProducts] of deptEntries) {
      const cells = this.buildMosaicCells(dept, deptProducts)
      if (cells.length < 2) continue
      const h = this.mosaicHeading(dept, deptProducts)
      panels.push({
        panelId: `panel_${slug(dept)}`, heading: h.text, priceFilter: h.priceFilter,
        seeMoreText: h.seeMoreText, seeMoreLink: `/department/${slug(dept)}`,
        dept, deptSlug: slug(dept), cells,
        theme: { backgroundColor: '#ffffff', headingColor: '#0f1111', accentColor: '#007185', hasBorder: true },
      })
      if (panels.length === 4) break
    }
    if (panels.length < 2) return null
    return {
      ...this.base(id, 'quad_mosaic_row', null, null, null, null, position, false,
        { layout: 'mosaic', columns: { desktop: 4, tablet: 2, mobile: 1 }, gap: 'md', backgroundColor: '#f7f8f8', lazy, minItemsToRender: 2, maxItemsToRender: 4, showTitle: false, showSeeMore: false, cardSize: 'md' }),
      data: { panels },
    } as QuadMosaicRowSection
  }

  private buildMosaicCells(dept: string, products: any[]): MosaicCell[] {
    const map = new Map<string, any[]>()
    for (const p of products) {
      const sub = (p.taxonomy_subcat ?? p.cat_lvl1 ?? '').trim()
      if (!sub || sub.toLowerCase() === dept.toLowerCase()) continue
      if (!map.has(sub)) map.set(sub, [])
      map.get(sub)!.push(p)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([sub, prods]) => {
      const catMeta = this.categories.categories.find((c: any) =>
        (c.name ?? '').toLowerCase() === sub.toLowerCase() || (c.slug ?? '') === slug(sub),
      )
      return {
        slug: catMeta?.slug ?? slug(sub), label: catMeta?.name ?? cap(sub),
        image: catMeta?.image ?? null,
        productImages: prods.filter((p: any) => p.thumbnail).slice(0, 4).map((p: any) => p.thumbnail as string),
        link: `/category/${catMeta?.slug ?? slug(sub)}`, altText: catMeta?.name ?? cap(sub),
      }
    })
  }

  private mosaicHeading(dept: string, prods: any[]): { text: string; priceFilter: any; seeMoreText: string } {
    const c = cap(dept)
    const u50 = prods.filter((p: any) => (p.price ?? 0) < 50).length / Math.max(prods.length, 1)
    if (u50 > 0.6) return { text: `New ${c} arrivals under $50`, priceFilter: { max: 50, label: 'under $50', currency: 'USD' }, seeMoreText: `Shop the latest from ${c}` }
    const opts: Record<number, string> = { 0: `Top categories in ${c}`, 1: `Shop ${c} for less`, 2: `Explore ${c}`, 3: `Find ${c} gifts`, 4: `Discover ${c}` }
    return { text: opts[dept.charCodeAt(0) % 5] ?? `Explore ${c}`, priceFilter: null, seeMoreText: `See all in ${c}` }
  }

  private buildCarousel(id: string, title: string, subtitle: string | null, badge: string | null, seeMoreLink: string | null, strategy: CarouselStrategy, strategyDept: string | null, products: ProductCardV2[], position: number, lazy: boolean, personalized = false): ProductCarouselSection {
    const pagination: CursorPage | null = products.length >= 24
      ? { nextCursor: Buffer.from(products[products.length - 1].asin).toString('base64'), prevCursor: null, hasNextPage: true, hasPrevPage: false, limit: 24 }
      : null
    return {
      ...this.base(id, 'product_carousel', title, subtitle, badge, seeMoreLink, position, personalized,
        { layout: 'carousel', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'sm', lazy, minItemsToRender: 3, maxItemsToRender: 24, showTitle: true, showSeeMore: !!seeMoreLink, cardSize: 'md' },
        personalized ? { minBreakpoint: 'xs', audience: 'authenticated' } : undefined),
      data: { strategy, strategyDept, products, pagination, totalAvailable: products.length },
    } as ProductCarouselSection
  }

  private buildDealGrid(dealProducts: any[], position: number): DealGridSection {
    const now = new Date()
    const refreshesAt = this.nextDealRefresh(now)
    const deals: DealCard[] = dealProducts.map((p: any, idx: number) => {
      const price = +(p.price ?? 0)
      const orig  = +(p.original_price ?? price * 1.3)
      const saved = +(orig - price).toFixed(2)
      const pct   = Math.round((saved / orig) * 100)
      const cp    = this.claimedPct(p.asin, now)
      return {
        asin: p.asin, slug: p.slug,
        title: p.title ?? '', brand: (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim(),
        thumbnail: p.thumbnail ?? '', thumbnails: Array.isArray(p.thumbnails) ? p.thumbnails : [],
        dept: p.taxonomy_dept ?? '', subcat: p.taxonomy_subcat ?? '',
        avgRating: +(p.avg_rating ?? 0), reviewCount: p.review_count ?? 0, isPrime: p.is_prime ?? false,
        purchaseSignal: this.purchaseSignal(p), badges: this.badges(p).slice(0, 2),
        stockSignal: this.stockSignal(p), deliveryPromise: this.deliveryPromise(p.is_prime ?? false),
        sponsored: false, sponsoredLabel: null, impressionToken: '',
        clickUrl: `/products/${p.slug}?ref=deal_grid&pos=${idx}`,
        deal: { type: 'deal_of_the_day' as DealType, label: "Today's Deal", originalPrice: orig, dealPrice: price, savingsAmount: saved, savingsPct: pct, endsAt: refreshesAt, claimedPct: cp, claimedLabel: `${cp}% claimed` },
        dealPosition: idx + 1,
      }
    })
    return {
      ...this.base('deal_grid_today', 'deal_grid', "Today's Deals", "Limited time offers — grab them before they're gone", '🏷️ Deals', '/products?on_sale=true', position, false,
        { layout: 'carousel', columns: { desktop: 5, tablet: 3, mobile: 2 }, gap: 'md', backgroundColor: '#fff3e0', lazy: false, minItemsToRender: 2, maxItemsToRender: 12, showTitle: true, showSeeMore: true, cardSize: 'lg' }),
      data: { refreshesAt, deals, viewAllLink: '/products?on_sale=true', totalDeals: this.products.products.filter((p: any) => p.is_on_sale || (p.discount_pct ?? 0) >= 10).length },
    } as DealGridSection
  }

  private buildBestsellerList(catName: string, products: any[], position: number): BestsellerListSection {
    const catSlug = slug(catName)
    const cards: ProductCardV2[] = products.slice(0, 12).map((p: any, idx: number) => {
      const card = this.toCardV2(p, 'bestseller_list', 'bestsellers')
      card.categoryRank = { rank: idx + 1, categoryName: catName, categoryLink: `/category/${catSlug}` }
      return card
    })
    return {
      ...this.base(`bestseller_list_${catSlug}`, 'bestseller_list', `Best Sellers in ${catName}`, null, '#1 Best Seller', `/category/${catSlug}`, position, false,
        { layout: 'carousel', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'sm', lazy: true, minItemsToRender: 4, maxItemsToRender: 12, showTitle: true, showSeeMore: true, cardSize: 'sm' }),
      data: { categoryName: catName, categorySlug: catSlug, categoryLink: `/category/${catSlug}`, products: cards },
    } as BestsellerListSection
  }

  buildAlsoViewedSection(page: number, position: number): AlsoViewedGridSection | null {
    const limit = 18
    const all   = this.products.products.filter((p: any) => p.is_active !== false)
    const total = Math.min(all.length, 126)
    if (!total) return null
    const pages   = Math.ceil(total / limit)
    const offset  = (page - 1) * limit
    const prods   = all.sort(byRating).slice(offset, offset + limit).map((p: any) => this.toCardV2(p, 'also_viewed_grid', 'also_viewed'))
    if (!prods.length) return null
    return {
      ...this.base('also_viewed_grid', 'also_viewed_grid', 'Customers who viewed items in your browsing history also viewed', null, null, '/products?trending=true', position, false,
        { layout: 'grid', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'md', lazy: true, minItemsToRender: 4, maxItemsToRender: 18, showTitle: true, showSeeMore: false, cardSize: 'sm' },
        { minBreakpoint: 'xs', audience: 'all' }),
      data: {
        headline: 'Customers who viewed items in your browsing history also viewed',
        products: prods,
        pagination: { page, totalPages: pages, totalItems: total, limit, hasNextPage: page < pages, hasPrevPage: page > 1, nextPageToken: page < pages ? Buffer.from(JSON.stringify({ page: page + 1 })).toString('base64') : null, prevPageToken: page > 1 ? Buffer.from(JSON.stringify({ page: page - 1 })).toString('base64') : null } as OffsetPage,
      },
    } as AlsoViewedGridSection
  }

  private emptyAlsoViewed(position: number): AlsoViewedGridSection {
    return {
      ...this.base('also_viewed_grid', 'also_viewed_grid', 'Customers who viewed items in your browsing history also viewed', null, null, '/products', position, false,
        { layout: 'grid', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'md', lazy: true, minItemsToRender: 1, maxItemsToRender: 18, showTitle: true, showSeeMore: false, cardSize: 'sm' },
        { minBreakpoint: 'xs', audience: 'all' }),
      data: { headline: 'Customers who viewed items in your browsing history also viewed', products: [], pagination: { page: 1, totalPages: 1, totalItems: 0, limit: 18, hasNextPage: false, hasPrevPage: false, nextPageToken: null, prevPageToken: null } as OffsetPage },
    } as AlsoViewedGridSection
  }

  private buildContinuePlaceholder(position: number): ContinueShoppingSection {
    return {
      ...this.base('continue_shopping', 'continue_shopping', 'Continue shopping for', null, null, '/products', position, true,
        { layout: 'carousel', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'sm', lazy: true, minItemsToRender: 2, maxItemsToRender: 12, showTitle: true, showSeeMore: true, cardSize: 'md' },
        { minBreakpoint: 'xs', audience: 'authenticated' }),
      data: { strategy: 'continue', products: [], pagination: null, totalAvailable: 0 },
    } as ContinueShoppingSection
  }

  private buildHistoryPlaceholder(position: number): BrowsingHistorySection {
    return {
      ...this.base('browsing_history', 'browsing_history', 'Based on your browsing history', null, null, '/products', position, true,
        { layout: 'carousel', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'sm', lazy: true, minItemsToRender: 2, maxItemsToRender: 12, showTitle: true, showSeeMore: true, cardSize: 'md' },
        { minBreakpoint: 'xs', audience: 'authenticated' }),
      data: { strategy: 'history_based', affinityDepts: [], products: [], pagination: null, totalAvailable: 0 },
    } as BrowsingHistorySection
  }

  // ── Personalization injection ─────────────────────────────────────────────────

  private injectPersonalization(sections: AnySection[], p13n: PersonalizationBundle): number {
    let count = 0
    const replace = (sectionId: string, fn: (s: any) => void) => {
      const idx = sections.findIndex((s) => s.sectionId === sectionId)
      if (idx !== -1) { fn(sections[idx]); count++ }
    }
    if (p13n.continueShoppingFor.products.length) {
      replace('continue_shopping', (s: ContinueShoppingSection) => { s.data.products = p13n.continueShoppingFor.products; s.data.totalAvailable = p13n.continueShoppingFor.count; s.personalized = true })
    }
    if (p13n.basedOnBrowsingHistory.products.length) {
      replace('browsing_history', (s: BrowsingHistorySection) => { s.data.products = p13n.basedOnBrowsingHistory.products; s.data.affinityDepts = p13n.topAffinityDepts; s.data.totalAvailable = p13n.basedOnBrowsingHistory.count; s.personalized = true })
    }
    if (p13n.moreToConsider.products.length) {
      replace('carousel_more_to_consider', (s: ProductCarouselSection) => { s.data.products = p13n.moreToConsider.products; s.data.strategy = 'more_to_consider'; s.data.totalAvailable = p13n.moreToConsider.count; s.personalized = true })
    }
    if (p13n.alsoViewed.products.length) {
      replace('also_viewed_grid', (s: AlsoViewedGridSection) => { s.data.products = p13n.alsoViewed.products; s.personalized = true })
    }
    return count
  }

  // ── ProductCardV2 ─────────────────────────────────────────────────────────────

  /**
   * Converts a RAW DB row from this.products.products → ProductCardV2.
   * Do NOT pass a toCard() result — raw DB column names required.
   */
  toCardV2(p: any, sectionId: string, strategy: string): ProductCardV2 {
    const price = +(p.price ?? 0)
    const orig  = p.original_price != null ? +p.original_price : null
    const disc  = p.discount_pct ?? 0
    const isPrime = p.is_prime ?? false
    return {
      asin: p.asin, slug: p.slug,
      title: p.title ?? '', brand: (p.brand ?? '').replace(/^Visit the\s+|\s+Store\s*$/gi, '').trim(),
      thumbnail: p.thumbnail ?? '', thumbnails: Array.isArray(p.thumbnails) ? p.thumbnails : [],
      dept: p.taxonomy_dept ?? p.cat_lvl0 ?? '', subcat: p.taxonomy_subcat ?? p.cat_lvl1 ?? '',
      price, originalPrice: orig, discountPct: disc,
      savingsAmount: orig != null ? +(orig - price).toFixed(2) : null,
      unitPrice: null, coupon: null,
      avgRating: +(p.avg_rating ?? 0), reviewCount: p.review_count ?? 0, ratingDistribution: null,
      isPrime, purchaseSignal: this.purchaseSignal(p), stockSignal: this.stockSignal(p),
      deliveryPromise: this.deliveryPromise(isPrime),
      badges: this.badges(p), categoryRank: this.categoryRank(p),
      deal: disc >= 10 ? this.dealInfo(p, price, orig ?? price * 1.3) : null,
      sponsored: false, sponsoredLabel: null,
      impressionToken: '', // stamped post-build
      clickUrl: `/products/${p.slug}?ref=${sectionId}&strategy=${strategy}`,
    }
  }

  // ── Analytics ─────────────────────────────────────────────────────────────────

  private stampAnalyticsTokens(sections: AnySection[]) {
    for (const s of sections) {
      const payload = { sectionId: s.sectionId, type: s.type, position: s.position, strategy: (s as any).data?.strategy ?? s.type, ts: Date.now() }
      s.analytics = { impressionToken: b64(payload), clickToken: b64({ ...payload, event: 'click' }), placementId: `${s.type}:${s.position}`, strategy: (s as any).data?.strategy ?? s.type }
    }
  }

  private stampImpressionTokens(sections: AnySection[]) {
    const stamp = (products: ProductCardV2[], sectionId: string) =>
      products.forEach((p, idx) => { p.impressionToken = b64({ asin: p.asin, sectionId, position: idx, ts: Date.now() }) })
    for (const s of sections) {
      const d = (s as any).data
      if (d?.products?.length) stamp(d.products, s.sectionId)
      if (d?.deals?.length)    stamp(d.deals,    s.sectionId)
    }
  }

  // ── Field helpers ─────────────────────────────────────────────────────────────

  private purchaseSignal(p: any): string | null {
    const b = p.bought_last_month
    if (!b || b < 50) return null
    if (b >= 10000) return `${Math.floor(b / 1000)}k+ bought in past month`
    if (b >= 1000)  return `${Math.floor(b / 100) / 10}k+ bought in past month`
    return `${b}+ bought in past month`
  }

  private stockSignal(p: any): StockSignal {
    if (!(p.in_stock ?? true)) return { status: 'out_of_stock', label: 'Currently unavailable', count: 0 }
    if ((p.is_deal ?? false) && (p.discount_pct ?? 0) >= 30) return { status: 'low_stock', label: 'Only a few left in stock – order soon', count: null }
    return { status: 'in_stock', label: null, count: null }
  }

  private deliveryPromise(isPrime: boolean): DeliveryPromise {
    const now  = new Date()
    const del  = new Date(now.getTime() + (isPrime ? 1 : 3) * 86_400_000)
    return {
      headline: `${isPrime ? 'FREE ' : ''}delivery ${DAYS_OF_WEEK[del.getDay()]}, ${MONTHS[del.getMonth()]} ${del.getDate()}`.trim(),
      isFree: isPrime, isPrime,
      cutoffLabel: isPrime ? `Order within ${this.hoursLeft(now)}` : null,
      dateRange: null,
    }
  }

  private badges(p: any): ProductBadge[] {
    const b: ProductBadge[] = []
    if (p.is_amazon_choice) b.push({ type: 'amazons_choice', label: "Amazon's Choice", subLabel: p.taxonomy_subcat ? `in ${cap(p.taxonomy_subcat)}` : null })
    if (p.is_best_seller)   b.push({ type: 'best_seller',   label: 'Best Seller',  subLabel: null })
    if (p.is_new_release)   b.push({ type: 'new_release',   label: 'New Release',  subLabel: null })
    if (p.is_trending)      b.push({ type: 'trending',      label: 'Trending',     subLabel: null })
    if (p.is_prime)         b.push({ type: 'prime',         label: 'Prime',        subLabel: null })
    if (p.is_free_ship)     b.push({ type: 'free_shipping', label: 'Free Shipping', subLabel: null })
    if (p.is_deal || (p.discount_pct ?? 0) >= 20) b.push({ type: 'deal', label: 'Deal', subLabel: null })
    if (p.is_top_rated)     b.push({ type: 'top_rated',     label: 'Top Rated',    subLabel: null })
    return b.slice(0, 3)
  }

  private categoryRank(p: any): CategoryRank | null {
    const ranks: any[] = p.bestsellers_rank ?? []
    if (!ranks.length) return null
    const top = ranks.reduce((a: any, b: any) => ((a.rank ?? 9999) < (b.rank ?? 9999) ? a : b))
    if (!top?.rank) return null
    return { rank: top.rank, categoryName: top.category ?? p.taxonomy_subcat ?? '', categoryLink: `/category/${slug(top.category ?? p.taxonomy_subcat ?? '')}` }
  }

  private dealInfo(p: any, price: number, orig: number): DealInfo {
    const saved  = +(orig - price).toFixed(2)
    const pct    = Math.round((saved / orig) * 100)
    const type: DealType = (p.discount_pct ?? 0) >= 50 ? 'deal_of_the_day' : p.is_deal ? 'lightning_deal' : 'price_drop'
    const cp     = type !== 'price_drop' ? this.claimedPct(p.asin, new Date()) : null
    return { type, label: type === 'deal_of_the_day' ? 'Deal of the Day' : type === 'lightning_deal' ? 'Lightning Deal' : 'Price Drop', originalPrice: orig, dealPrice: price, savingsAmount: saved, savingsPct: pct, endsAt: type !== 'price_drop' ? this.nextDealRefresh(new Date()) : null, claimedPct: cp, claimedLabel: cp != null ? `${cp}% claimed` : null }
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

  private async buildNav(deptMap: Map<string, any[]>): Promise<NavigationContext> {
    const cached = await this.cache.getAsync<NavigationContext>(CACHE_KEY_NAV)
    if (cached) return cached.value
    const departments: NavDepartment[] = [...deptMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([dept, products]) => {
      const subcatMap = new Map<string, number>()
      for (const p of products) { const sub = (p.taxonomy_subcat ?? '').trim(); if (sub) subcatMap.set(sub, (subcatMap.get(sub) ?? 0) + 1) }
      return { slug: slug(dept), name: cap(dept), link: `/department/${slug(dept)}`, icon: null, productCount: products.length, subcategories: [...subcatMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([sub, count]) => ({ slug: slug(sub), name: cap(sub), link: `/category/${slug(sub)}`, productCount: count })) }
    })
    const nav: NavigationContext = { departments }
    this.cache.set(CACHE_KEY_NAV, nav, TTL.CATEGORIES)
    return nav
  }

  private buildPageContext(campaign: RawCampaign | null): PageContext {
    return {
      title: campaign ? `${campaign.name} Deals — Pikly` : 'Pikly — Shop Electronics, Fashion, Home & More',
      description: 'Shop millions of products at unbeatable prices. Free delivery on eligible orders.',
      canonical: 'https://pikly.com', ogImage: null,
      campaign: campaign ? { id: campaign.id, name: campaign.name, tagline: campaign.tagline ?? `Shop ${campaign.name} deals`, startsAt: campaign.starts_at, endsAt: campaign.ends_at, theme: campaign.theme ?? { primaryColor: '#ff9900', accentColor: '#e91e8c', heroBackground: '#f0f0f0', badgeLabel: `${campaign.name} Deal` } } : null,
      structuredData: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Pikly', url: 'https://pikly.com', potentialAction: { '@type': 'SearchAction', target: 'https://pikly.com/products?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
    }
  }

  // ── Section base ──────────────────────────────────────────────────────────────

  private base(
    sectionId: string, type: any, title: string | null, subtitle: string | null,
    badge: string | null, seeMoreLink: string | null, position: number, personalized: boolean,
    rh?: Partial<RenderHints>, vis?: Partial<VisibilityRules>,
  ): Omit<SectionBase, 'data'> {
    return {
      sectionId, type, title, subtitle, badge, seeMoreLink, position, personalized,
      personalizationRequired: false,
      renderHints: { layout: 'carousel', columns: { desktop: 6, tablet: 4, mobile: 2 }, gap: 'md', backgroundColor: null, textColor: null, lazy: position > 4, minItemsToRender: 2, maxItemsToRender: 24, showTitle: !!title, showSeeMore: !!seeMoreLink, cardSize: 'md', ...rh } as RenderHints,
      analytics: { impressionToken: '', clickToken: '', placementId: `${type}:${position}`, strategy: type },
      experiment: null,
      visibility: { minBreakpoint: 'xs', audience: 'all', ...vis } as VisibilityRules,
    }
  }

  // ── DB ────────────────────────────────────────────────────────────────────────

  private async fetchBanners(): Promise<any[]> {
    const cached = this.cache.get<any[]>(CACHE_KEY_BANNERS)
    if (cached) return cached
    try {
      const rows = await this.db.query<any>('SELECT * FROM store.banners WHERE is_active=true ORDER BY sort_order ASC LIMIT 20')
      this.cache.set(CACHE_KEY_BANNERS, rows, TTL.BANNERS)
      return rows
    } catch { return [] }
  }

  private async fetchActiveCampaign(): Promise<RawCampaign | null> {
    // FIX-4: store.campaigns does not exist yet — try/catch handles gracefully.
    // Run sql/004_campaigns.sql to enable this feature.
    try {
      const now = new Date().toISOString()
      const rows = await this.db.query<any>('SELECT * FROM store.campaigns WHERE is_active=true AND starts_at<=$1 AND ends_at>=$1 ORDER BY priority DESC LIMIT 1', [now])
      return rows[0] ?? null
    } catch { return null }
  }

  // ── Pure utils ────────────────────────────────────────────────────────────────

  private claimedPct(asin: string, now: Date): number {
    const seed = [...asin].reduce((a, c) => a + c.charCodeAt(0), 0)
    return Math.min(95, 20 + (seed % 36) + Math.floor((now.getHours() / 24) * 30))
  }

  private nextDealRefresh(now: Date): string {
    const r = new Date(now); r.setUTCHours(DEAL_REFRESH_H, 0, 0, 0)
    if (r <= now) r.setUTCDate(r.getUTCDate() + 1)
    return r.toISOString()
  }

  private hoursLeft(now: Date): string {
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0)
    const diff = midnight.getTime() - now.getTime()
    const h = Math.floor(diff / 3_600_000); const m = Math.floor((diff % 3_600_000) / 60_000)
    return h > 0 ? `${h} hrs ${m} mins` : `${m} mins`
  }

  private findTopBestsellerCat(bestsellers: any[]): string {
    const map = new Map<string, number>()
    for (const p of bestsellers) { const c = p.taxonomy_subcat ?? p.taxonomy_dept ?? 'General'; map.set(c, (map.get(c) ?? 0) + 1) }
    return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Clothing, Shoes & Jewelry'
  }

  private countProducts(sections: AnySection[]): number {
    return sections.reduce((n, s) => { const d = (s as any).data; return n + (d?.products?.length ?? 0) + (d?.deals?.length ?? 0) }, 0)
  }
}

// ── Module-level pure helpers (no this) ───────────────────────────────────────

const byRating   = (a: any, b: any) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0)
const byDiscount = (a: any, b: any) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0)
const byDate     = (a: any, b: any) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()

const slug = (str: string) => str.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
const cap  = (str: string) => str ? str.charAt(0).toUpperCase() + str.slice(1).replace(/-/g, ' & ') : str
const b64  = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64')

function buildDeptMap(raw: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>()
  for (const p of raw) {
    const dept = (p.taxonomy_dept ?? p.cat_lvl0 ?? '').trim()
    if (!dept) continue
    if (!map.has(dept)) map.set(dept, [])
    map.get(dept)!.push(p)
  }
  return map
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface BasePayload { page: PageContext; nav: NavigationContext; sections: AnySection[]; nextPosition: number }

interface RawCampaign {
  id: string; name: string; headline: string; tagline: string | null; subheadline: string | null
  background_image: string | null; starts_at: string; ends_at: string; is_active: boolean; priority: number
  tiles: any[]
  theme: { primaryColor: string; accentColor: string; heroBackground: string; badgeLabel: string } | null
}
