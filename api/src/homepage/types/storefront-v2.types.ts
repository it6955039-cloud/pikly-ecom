// ============================================================
// storefront-v2.types.ts
//
// Pikly Storefront API — Complete Type System v2.0
//
// Design philosophy:
//   • Every field is frontend-actionable — no raw DB columns leaking through
//   • Zero ambiguity: frontend never needs to derive, compute, or guess anything
//   • Amazon-vocabulary section types with 1:1 component mapping
//   • Personalization merged into the section array — no secondary call
//   • Analytics tokens baked in — no extra instrumentation layer
//   • Render hints baked in — no hardcoded layout logic in components
//
// Section type → frontend component mapping:
//   hero_banner         → HeroBannerSlider
//   quad_mosaic_row     → QuadMosaicRow      ← THE core Amazon pattern (4 panels/row)
//   product_carousel    → ProductCarousel
//   deal_grid           → DealGrid           ← countdown + % claimed
//   editorial_campaign  → EditorialCampaign  ← Mother's Day / Prime Day themed hero
//   bestseller_list     → BestsellerList     ← ranked strip with #N badge
//   also_viewed_grid    → AlsoViewedGrid     ← paginated grid, "Page 1 of 7"
//   continue_shopping   → ContinueShopping   ← personalized recent-view rail
//   browsing_history    → BrowsingHistory    ← personalized dept-affinity carousel
//   sub_nav_strip       → SubNavStrip        ← horizontal scrollable dept links
//
// ============================================================

// ─────────────────────────────────────────────────────────────────────────────
// § 1. TOP-LEVEL ENVELOPE
// ─────────────────────────────────────────────────────────────────────────────

export interface StorefrontV2Response {
  /** Schema discriminator — bump minor on backward-compat additions, major on breaks */
  schema: 'pikly_storefront_v2'

  /** Page-level metadata for SSR/SEO/campaign theming */
  page: PageContext

  /** Navigation bar data — departments + category mega-menu */
  nav: NavigationContext

  /**
   * Ordered sections array. Frontend iterates this array and renders
   * each section using the component keyed by `section.type`.
   * Sections are pre-sorted by `position`; frontend MUST NOT re-sort.
   */
  sections: AnySection[]

  /**
   * Named personalization injection points.
   * For authenticated users: fully resolved data arrays.
   * For anonymous users: null (client swaps in after login).
   *
   * Note: personalized sections ALSO appear in `sections[]` at the correct
   * position with `personalized: true` and `personalizationRequired: false`
   * when userId is provided. This field is the raw data for custom injection.
   */
  personalization: PersonalizationBundle | null

  /** Response-level diagnostics */
  meta: StorefrontMeta
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. PAGE CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

export interface PageContext {
  /** Browser/SEO title */
  title: string

  /** Meta description for SEO */
  description: string

  /** Canonical URL */
  canonical: string

  /** OG image for social sharing */
  ogImage: string | null

  /**
   * Active seasonal campaign context.
   * null → standard homepage.
   * When set, frontend applies campaign theming (colors, fonts, hero imagery).
   */
  campaign: CampaignContext | null

  /** JSON-LD structured data (Organization + WebSite schema) */
  structuredData: JsonLdWebSite
}

export interface CampaignContext {
  /** Internal campaign identifier */
  id: string

  /** Display name e.g. "Mother's Day", "Prime Day", "Black Friday" */
  name: string

  /** Short tagline shown in campaign hero */
  tagline: string

  /** ISO8601 campaign window */
  startsAt: string
  endsAt: string

  /** Theme overrides — CSS custom property values */
  theme: {
    primaryColor: string        // e.g. "#e91e8c"
    accentColor: string         // e.g. "#ff9900"
    heroBackground: string      // URL or CSS gradient
    badgeLabel: string          // e.g. "Mother's Day Deal"
  }
}

export interface JsonLdWebSite {
  '@context': 'https://schema.org'
  '@type': 'WebSite'
  name: string
  url: string
  potentialAction: {
    '@type': 'SearchAction'
    target: string
    'query-input': string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. NAVIGATION CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

export interface NavigationContext {
  /** Top-level departments for the horizontal nav bar */
  departments: NavDepartment[]
}

export interface NavDepartment {
  slug: string
  name: string
  link: string
  icon: string | null            // icon name / SVG URL
  productCount: number

  /** Second-level subcategories for mega-menu dropdown */
  subcategories: NavSubcategory[]
}

export interface NavSubcategory {
  slug: string
  name: string
  link: string
  productCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. PRODUCT CARD v2
//
// Richest possible product card — every field the frontend will ever need.
// Used uniformly across ALL section types to eliminate impedance mismatch.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductCardV2 {
  // ── Identity ──────────────────────────────────────────────────────────────
  asin: string
  slug: string

  // ── Content ───────────────────────────────────────────────────────────────
  title: string
  brand: string
  thumbnail: string              // primary display image
  thumbnails: string[]           // hover / gallery images

  // ── Taxonomy ──────────────────────────────────────────────────────────────
  dept: string
  subcat: string

  // ── Pricing ───────────────────────────────────────────────────────────────
  price: number                  // current sale price
  originalPrice: number | null   // struck-through price
  discountPct: number            // 0–100
  savingsAmount: number | null   // absolute $ saved — "Save $12.00"

  /**
   * Unit price for comparison shopping.
   * e.g. "$0.50/oz", "$2.33/count", "$1.25/100ml"
   * null when not applicable.
   */
  unitPrice: string | null

  /**
   * Inline coupon label.
   * e.g. "Clip 15% coupon", "Save extra $3 with coupon"
   * null when no coupon.
   */
  coupon: string | null

  // ── Ratings ───────────────────────────────────────────────────────────────
  avgRating: number              // 0.0–5.0
  reviewCount: number
  ratingDistribution: RatingDistribution | null  // null in list view, present in detail

  // ── Commerce signals ──────────────────────────────────────────────────────
  isPrime: boolean

  /**
   * Purchase velocity signal. "200+ bought in past month"
   * Shown below price to create social proof urgency.
   */
  purchaseSignal: string | null

  /**
   * "Only 3 left in stock – order soon"
   * Critical conversion driver — show in red when count <= 10.
   */
  stockSignal: StockSignal

  // ── Delivery promise ──────────────────────────────────────────────────────
  /**
   * FREE delivery Saturday, Apr 26.
   * The delivery promise is THE #1 conversion driver on Amazon.
   * Every card must surface it — do not omit.
   */
  deliveryPromise: DeliveryPromise | null

  // ── Badges ────────────────────────────────────────────────────────────────
  /**
   * Ordered by display priority. Frontend shows first 2–3.
   * Badge types drive distinct visual treatment (color, icon, shape).
   */
  badges: ProductBadge[]

  /**
   * Category rank — "#1 Best Seller in Headphones"
   * null when product is not ranked in top 100 of its category.
   */
  categoryRank: CategoryRank | null

  // ── Deal information ──────────────────────────────────────────────────────
  /**
   * null → not a deal
   * Present → render deal overlay with countdown / progress
   */
  deal: DealInfo | null

  // ── Sponsored ─────────────────────────────────────────────────────────────
  sponsored: boolean
  sponsoredLabel: string | null  // "Sponsored" | "Ad" — localisation-ready

  // ── Analytics ─────────────────────────────────────────────────────────────
  /**
   * Opaque base64 token — attach to impression ping.
   * Format: base64(JSON { asin, sectionId, position, strategy, ts })
   */
  impressionToken: string

  /**
   * Canonical product URL with attribution params.
   * Use this for all links to ensure attribution is tracked.
   */
  clickUrl: string
}

export interface RatingDistribution {
  five: number    // percentage
  four: number
  three: number
  two: number
  one: number
}

export type StockStatus = 'in_stock' | 'low_stock' | 'last_few' | 'out_of_stock'

export interface StockSignal {
  status: StockStatus
  /** "Only 3 left in stock – order soon" | null when status = 'in_stock' */
  label: string | null
  /** Exact count when ≤ 10, null otherwise (avoids exposing inventory data) */
  count: number | null
}

export interface DeliveryPromise {
  /** "FREE delivery Saturday, Apr 26" — pre-composed, ready to render */
  headline: string
  isFree: boolean
  isPrime: boolean
  /** "Order within 2 hrs 15 mins" — null when no cutoff applies */
  cutoffLabel: string | null
  /** Delivery date range label — "Apr 26 – Apr 28" */
  dateRange: string | null
}

export type BadgeType =
  | 'amazons_choice'         // Amazon's Choice — orange border + logo
  | 'best_seller'            // #1 Best Seller — orange banner
  | 'new_release'            // New Release — green
  | 'climate_pledge'         // Climate Pledge Friendly — green leaf
  | 'prime'                  // Prime eligible — Prime logo
  | 'deal'                   // Generic deal — red
  | 'lightning_deal'         // Lightning Deal — yellow/orange
  | 'limited_time_deal'      // Limited time deal — red
  | 'free_shipping'          // Free shipping — blue
  | 'trending'               // Trending — pink/purple
  | 'top_rated'              // Top Rated — gold star
  | 'prime_exclusive'        // Prime exclusive — navy
  | 'small_business'         // Small Business — teal

export interface ProductBadge {
  type: BadgeType
  label: string              // Display text — "Amazon's Choice", "Best Seller", etc.
  /** Sub-label for Amazon's Choice — "in Wireless Headphones" */
  subLabel: string | null
}

export interface CategoryRank {
  rank: number               // 1, 2, 3 ...
  categoryName: string       // "Over-Ear Headphones"
  categoryLink: string
}

export type DealType =
  | 'lightning_deal'
  | 'deal_of_the_day'
  | 'coupon'
  | 'prime_exclusive_deal'
  | 'promotion'
  | 'price_drop'

export interface DealInfo {
  type: DealType

  /** "Lightning Deal", "Deal of the Day", "Clip coupon" */
  label: string

  originalPrice: number
  dealPrice: number
  savingsAmount: number
  savingsPct: number

  /**
   * ISO8601 expiry — null for open-ended promotions.
   * Frontend computes countdown from this.
   */
  endsAt: string | null

  /**
   * Percentage of deal inventory already claimed.
   * Frontend renders red progress bar — "52% claimed".
   * null when not applicable (coupon / promotion types).
   */
  claimedPct: number | null

  /** "52% claimed" — pre-composed label */
  claimedLabel: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. SECTION BASE + DISCRIMINATED UNION
// ─────────────────────────────────────────────────────────────────────────────

/** Fields present on EVERY section regardless of type */
export interface SectionBase {
  /** Stable React list key — never changes after creation */
  sectionId: string

  /** Component discriminator */
  type: SectionType

  /** Display title — null for hero/editorial sections that self-contain copy */
  title: string | null

  /** Secondary line beneath title */
  subtitle: string | null

  /** Badge label e.g. "🔥 Trending" — null when absent */
  badge: string | null

  /**
   * "See all" / "See more" destination.
   * null for sections with no canonical browse page.
   */
  seeMoreLink: string | null

  /** Display order — lower = higher on page. Frontend MUST NOT re-sort. */
  position: number

  /**
   * Personalized section flag.
   * true → section data is user-specific, do not SSR without user context.
   * false → section is global, safe to SSR / cache publicly.
   */
  personalized: boolean

  /**
   * When true: section is a personalization placeholder.
   * Frontend renders skeleton + deferred fetch after auth resolves.
   * Only set to true on anonymous responses.
   */
  personalizationRequired: boolean

  /** Render directives — frontend should respect these exactly */
  renderHints: RenderHints

  /** Analytics metadata for impression/click tracking */
  analytics: SectionAnalytics

  /**
   * A/B experiment context.
   * null when section is not part of an active experiment.
   */
  experiment: ExperimentContext | null

  /**
   * Visibility rules.
   * Frontend applies these at render time — server always returns the section
   * (for SSR consistency) but client hides/shows per these rules.
   */
  visibility: VisibilityRules
}

export type SectionType =
  | 'hero_banner'
  | 'quad_mosaic_row'
  | 'product_carousel'
  | 'deal_grid'
  | 'editorial_campaign'
  | 'bestseller_list'
  | 'also_viewed_grid'
  | 'continue_shopping'
  | 'browsing_history'
  | 'sub_nav_strip'

export interface RenderHints {
  /**
   * Layout algorithm.
   * 'carousel'  → horizontal scroll with arrow buttons
   * 'grid'      → responsive grid
   * 'mosaic'    → fixed 4-panel layout (Amazon quad pattern)
   * 'hero'      → full-width slider
   * 'list'      → vertical stacked list
   * 'strip'     → single row, no scroll
   */
  layout: 'carousel' | 'grid' | 'mosaic' | 'hero' | 'list' | 'strip'

  /** Grid column count — desktop / tablet / mobile */
  columns: { desktop: number; tablet: number; mobile: number }

  /** Gap between items (CSS token) */
  gap: 'xs' | 'sm' | 'md' | 'lg'

  /** Section background color override (CSS value or null for default) */
  backgroundColor: string | null

  /** Section text color override */
  textColor: string | null

  /**
   * Lazy-load hint.
   * false → load eagerly (above fold — first 3–4 sections).
   * true  → use IntersectionObserver (below fold).
   */
  lazy: boolean

  /**
   * Minimum number of items required to render this section.
   * If data.products.length < minItemsToRender, frontend skips the section.
   */
  minItemsToRender: number

  /** Maximum items to render initially (rest loaded on "See more") */
  maxItemsToRender: number

  /** Whether to show the section title in the rendered component */
  showTitle: boolean

  /** Whether to show the "See more / See all" link */
  showSeeMore: boolean

  /** Card size variant within carousels/grids */
  cardSize: 'xs' | 'sm' | 'md' | 'lg'
}

export interface SectionAnalytics {
  /** Impression tracking token — POST to /analytics/impression on mount */
  impressionToken: string
  /** Click tracking token — POST to /analytics/click on interaction */
  clickToken: string
  /** Placement ID for ad server / analytics pipeline */
  placementId: string
  /** Data strategy that produced this section */
  strategy: string
}

export interface ExperimentContext {
  experimentId: string
  variant: 'control' | 'A' | 'B' | 'C'
  /** Whether to report this impression to the experiment service */
  trackImpression: boolean
}

export interface VisibilityRules {
  /**
   * Minimum viewport breakpoint to render.
   * 'xs' = always | 'sm' = ≥576px | 'md' = ≥768px | 'lg' = ≥1024px
   */
  minBreakpoint: 'xs' | 'sm' | 'md' | 'lg'

  /** null = everyone | 'authenticated' = logged-in only | 'anonymous' = guests only */
  audience: 'all' | 'authenticated' | 'anonymous'
}

// ── Concrete section types ────────────────────────────────────────────────────

export type AnySection =
  | HeroBannerSection
  | QuadMosaicRowSection
  | ProductCarouselSection
  | DealGridSection
  | EditorialCampaignSection
  | BestsellerListSection
  | AlsoViewedGridSection
  | ContinueShoppingSection
  | BrowsingHistorySection
  | SubNavStripSection

// ─────────────────────────────────────────────────────────────────────────────
// § 6. HERO BANNER
// ─────────────────────────────────────────────────────────────────────────────

export interface HeroBannerSection extends SectionBase {
  type: 'hero_banner'
  data: HeroBannerData
}

export interface HeroBannerData {
  banners: HeroBannerSlide[]
  /** Auto-advance interval in milliseconds — null = manual only */
  autoplayMs: number | null
  /** Image aspect ratio hint for skeleton loading */
  aspectRatio: '21:9' | '16:9' | '3:1' | '4:1'
}

export interface HeroBannerSlide {
  id: string
  position: number

  // Content
  title: string | null
  subtitle: string | null
  eyebrow: string | null        // small text above title — "Limited Time"

  // Imagery
  desktopImage: string | null
  mobileImage: string | null
  altText: string

  // CTA
  ctaText: string | null
  ctaLink: string | null
  ctaStyle: 'primary' | 'secondary' | 'ghost'

  // Theme
  textAlignment: 'left' | 'center' | 'right'
  textColor: 'light' | 'dark'
  overlayOpacity: number        // 0–1

  // Campaign tag
  badge: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. QUAD MOSAIC ROW  ← THE CORE AMAZON PATTERN
//
// Four department panels rendered in a single horizontal row.
// Each panel has a heading + up to 4 image cells in a 2×2 grid.
//
// Amazon examples:
//   "Get your game on" | "New home arrivals under $50" |
//   "Top categories in Kitchen appliances" | "Find gifts for Mom"
//
// This section type is the primary building block of the Amazon homepage.
// It replaces the separate category_grid + dept_spotlight types from v1.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuadMosaicRowSection extends SectionBase {
  type: 'quad_mosaic_row'
  data: QuadMosaicRowData
}

export interface QuadMosaicRowData {
  /**
   * Exactly 4 panels — always render all 4 or none.
   * If fewer than 4 are available, the builder pads with the next-best dept.
   */
  panels: MosaicPanel[]
}

export interface MosaicPanel {
  panelId: string

  // ── Header ─────────────────────────────────────────────────────────────
  /** Bold section heading — "Get your game on" */
  heading: string

  /**
   * Optional price filter sub-heading — "New home arrivals under $50"
   * When set, all cells are filtered to maxPrice.
   */
  priceFilter: PriceFilter | null

  /** "Shop the latest from Home" — link below the cells grid */
  seeMoreText: string
  seeMoreLink: string

  // ── Department context ─────────────────────────────────────────────────
  dept: string
  deptSlug: string

  // ── Image cells (2×2 grid) ─────────────────────────────────────────────
  /**
   * 2–4 cells rendered as a 2×2 image grid.
   * Each cell is a subcategory with label + image.
   */
  cells: MosaicCell[]

  // ── Panel theme ────────────────────────────────────────────────────────
  theme: MosaicPanelTheme
}

export interface PriceFilter {
  max: number                    // 50
  label: string                  // "under $50"
  currency: string               // "USD"
}

export interface MosaicCell {
  /** Subcategory slug */
  slug: string

  /** Display label — "Kitchen & Dining", "Home Improvement" */
  label: string

  /**
   * Category image URL — preferred.
   * Falls back to best product thumbnail when null.
   */
  image: string | null

  /** Fallback product thumbnails when category image is null */
  productImages: string[]

  /** Navigation target */
  link: string

  /** Alt text for accessibility */
  altText: string
}

export interface MosaicPanelTheme {
  /** Background color of the panel card */
  backgroundColor: string       // default "#fff"
  /** Heading text color */
  headingColor: string          // default "#0f1111"
  /** Accent color for "See more" link */
  accentColor: string           // default "#007185"
  /** Whether panel has a visible border */
  hasBorder: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8. PRODUCT CAROUSEL
// ─────────────────────────────────────────────────────────────────────────────

export interface ProductCarouselSection extends SectionBase {
  type: 'product_carousel'
  data: ProductCarouselData
}

export interface ProductCarouselData {
  /**
   * Data sourcing strategy — informs analytics and cache invalidation.
   * 'featured'       → Amazon's Choice + Editor picks
   * 'bestsellers'    → Best-selling by volume
   * 'trending'       → Velocity-based trending
   * 'new_arrivals'   → Recently added to catalog
   * 'on_sale'        → Discount ≥ 10%
   * 'top_rated'      → Rating ≥ 4.5 + reviews ≥ 100
   * 'by_dept'        → Dept-filtered, sorted by rating
   * 'also_viewed'    → Collaborative filter (personalized)
   * 'continue'       → Recently viewed, not purchased (personalized)
   * 'history_based'  → Dept-affinity (personalized)
   * 'more_to_consider' → Trending in affinity depts (personalized)
   */
  strategy: CarouselStrategy

  /** Dept slug when strategy = 'by_dept' — null otherwise */
  strategyDept: string | null

  products: ProductCardV2[]

  /**
   * Cursor-based pagination for "load more" (infinite scroll).
   * null = all data loaded.
   */
  pagination: CursorPage | null

  /**
   * Total number of products available for this strategy
   * (used to render "Showing X of Y" copy).
   */
  totalAvailable: number
}

export type CarouselStrategy =
  | 'featured'
  | 'bestsellers'
  | 'trending'
  | 'new_arrivals'
  | 'on_sale'
  | 'top_rated'
  | 'by_dept'
  | 'also_viewed'
  | 'continue'
  | 'history_based'
  | 'more_to_consider'

export interface CursorPage {
  nextCursor: string | null
  prevCursor: string | null
  hasNextPage: boolean
  hasPrevPage: boolean
  limit: number
}

// ─────────────────────────────────────────────────────────────────────────────
// § 9. DEAL GRID
//
// "Today's Deals" — prominent deal section with countdown timers
// and inventory % claimed progress bars.
// ─────────────────────────────────────────────────────────────────────────────

export interface DealGridSection extends SectionBase {
  type: 'deal_grid'
  data: DealGridData
}

export interface DealGridData {
  /**
   * Deal refresh timestamp — deals update at this time.
   * ISO8601. Frontend shows "Deals refresh in Xh Ym Zs" countdown.
   */
  refreshesAt: string

  deals: DealCard[]

  /** "See all deals" destination */
  viewAllLink: string

  /** Total number of active deals in catalog */
  totalDeals: number
}

export interface DealCard {
  // Inherits all ProductCardV2 fields
  asin: string
  slug: string
  title: string
  brand: string
  thumbnail: string
  thumbnails: string[]
  dept: string
  subcat: string
  avgRating: number
  reviewCount: number
  isPrime: boolean
  badges: ProductBadge[]
  stockSignal: StockSignal
  deliveryPromise: DeliveryPromise | null
  purchaseSignal: string | null
  impressionToken: string
  clickUrl: string
  sponsored: boolean
  sponsoredLabel: string | null

  // Deal-specific fields (always present in DealCard)
  deal: Required<DealInfo>

  /** Index within deals array — used for "Deal 3 of 12" copy */
  dealPosition: number
}

// ─────────────────────────────────────────────────────────────────────────────
// § 10. EDITORIAL CAMPAIGN
//
// Full-width seasonal feature section with custom background and themed layout.
// "Explore Mother's Day deals", "Prime Day", "Back to School", etc.
// ─────────────────────────────────────────────────────────────────────────────

export interface EditorialCampaignSection extends SectionBase {
  type: 'editorial_campaign'
  data: EditorialCampaignData
}

export interface EditorialCampaignData {
  campaignId: string
  campaignName: string           // "Mother's Day"
  headline: string               // "Explore Mother's Day deals"
  subheadline: string | null
  backgroundImage: string | null // Full-width BG image URL
  backgroundGradient: string | null // CSS gradient fallback
  textColor: 'light' | 'dark'
  ctaText: string | null
  ctaLink: string | null

  /**
   * Category tiles within the campaign.
   * e.g. "Apparel", "Shoes", "Jewelry", "Handbags"
   */
  tiles: EditorialTile[]
}

export interface EditorialTile {
  id: string
  label: string
  image: string | null
  link: string
  badge: string | null           // "Up to 40% off"
}

// ─────────────────────────────────────────────────────────────────────────────
// § 11. BESTSELLER LIST
//
// "Best Sellers in Clothing, Shoes & Jewelry"
// Horizontal product strip with rank badge overlay (#1, #2, #3 …)
// ─────────────────────────────────────────────────────────────────────────────

export interface BestsellerListSection extends SectionBase {
  type: 'bestseller_list'
  data: BestsellerListData
}

export interface BestsellerListData {
  categoryName: string           // "Clothing, Shoes & Jewelry"
  categorySlug: string
  categoryLink: string

  /**
   * Top-ranked products. `product.categoryRank.rank` provides the #N badge.
   * Frontend overlays rank badge on thumbnail corner.
   */
  products: ProductCardV2[]
}

// ─────────────────────────────────────────────────────────────────────────────
// § 12. ALSO VIEWED GRID
//
// "Customers who viewed items in your browsing history also viewed"
// Paginated product grid — "Page 1 of 7"
// ─────────────────────────────────────────────────────────────────────────────

export interface AlsoViewedGridSection extends SectionBase {
  type: 'also_viewed_grid'
  data: AlsoViewedGridData
}

export interface AlsoViewedGridData {
  /** "Customers who viewed items in your browsing history also viewed" */
  headline: string
  products: ProductCardV2[]
  pagination: OffsetPage
}

export interface OffsetPage {
  page: number
  totalPages: number
  totalItems: number
  limit: number
  hasNextPage: boolean
  hasPrevPage: boolean
  /** Token for /homepage/storefront?alsoViewedPage=2 */
  nextPageToken: string | null
  prevPageToken: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// § 13. PERSONALIZED SECTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** "Continue shopping for" — recently viewed, not purchased */
export interface ContinueShoppingSection extends SectionBase {
  type: 'continue_shopping'
  data: ContinueShoppingData
}

export interface ContinueShoppingData {
  strategy: 'continue'
  products: ProductCardV2[]
  pagination: CursorPage | null
  totalAvailable: number
}

/** "Based on your browsing history" — dept-affinity recommendations */
export interface BrowsingHistorySection extends SectionBase {
  type: 'browsing_history'
  data: BrowsingHistoryData
}

export interface BrowsingHistoryData {
  strategy: 'history_based'
  /** Departments that drove these recommendations */
  affinityDepts: string[]
  products: ProductCardV2[]
  pagination: CursorPage | null
  totalAvailable: number
}

// ─────────────────────────────────────────────────────────────────────────────
// § 14. SUB-NAV STRIP
//
// Horizontal scrollable department links — appears after hero banner.
// "All | Today's Deals | Electronics | Fashion | Home | Books …"
// ─────────────────────────────────────────────────────────────────────────────

export interface SubNavStripSection extends SectionBase {
  type: 'sub_nav_strip'
  data: SubNavStripData
}

export interface SubNavStripData {
  links: SubNavLink[]
}

export interface SubNavLink {
  label: string
  link: string
  icon: string | null
  badge: string | null           // "Hot", "New"
  active: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// § 15. PERSONALIZATION BUNDLE
//
// Raw personalization data — merged into sections[] for auth users.
// Also exposed here for client-side injection / progressive enhancement.
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonalizationBundle {
  userId: string
  hasHistory: boolean
  topAffinityDepts: string[]

  /** Recently viewed, not yet purchased */
  continueShoppingFor: PersonalizedSlot

  /** Top-rated products from affinity departments */
  basedOnBrowsingHistory: PersonalizedSlot

  /** Item-item collaborative filter (co-occurrence) */
  alsoViewed: PersonalizedSlot

  /** Trending in affinity departments */
  moreToConsider: PersonalizedSlot

  computedAt: string
  fromCache: boolean
}

export interface PersonalizedSlot {
  label: string
  strategy: CarouselStrategy
  products: ProductCardV2[]
  count: number
}

// ─────────────────────────────────────────────────────────────────────────────
// § 16. RESPONSE META
// ─────────────────────────────────────────────────────────────────────────────

export interface StorefrontMeta {
  schema: 'pikly_storefront_v2'
  apiVersion: string            // semver — "2.0.0"
  generatedAt: string           // ISO8601

  /** Cache tier that served this response */
  cacheHit: boolean
  cacheTier: 'L1' | 'L2' | 'none'
  cacheTtlRemaining: number | null   // seconds until cache expires

  sectionCount: number
  productCount: number          // total product cards in response

  /** Per-section build time for profiling (ms). Only in non-prod. */
  timing: SectionTiming[] | null

  /** Personalization context */
  personalizationContext: {
    userId: string | null
    isAuthenticated: boolean
    hasHistory: boolean
    personalizedSectionCount: number
  }

  /** Feature flags active for this response */
  featureFlags: Record<string, boolean>

  /** Active campaign ID — null when no campaign running */
  activeCampaignId: string | null
}

export interface SectionTiming {
  sectionId: string
  buildMs: number
  strategy: string
}
