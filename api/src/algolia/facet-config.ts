// src/algolia/facet-config.ts — Updated for 24 departments + scraped data structure
// All facet counts come from Algolia. Zero JS computed counts.

export type FacetType = 'disjunctive' | 'conjunctive' | 'boolean' | 'range' | 'hierarchical'

export interface FacetDimension {
  queryKey:    string
  algoliaAttr: string
  type:        FacetType
  label:       string
  disjunctive: boolean
  maxValues:   number
  searchable:  boolean
  sortBy:      'count' | 'alpha'
}

export const FACET_DIMENSIONS: FacetDimension[] = [
  // ── Hierarchical category (matches scraped taxonomy.department → subcategory) ──
  { queryKey:'dept',       algoliaAttr:'taxonomyDept',   type:'hierarchical', label:'Department',       disjunctive:false, maxValues:50,  searchable:false, sortBy:'count' },
  { queryKey:'subcat',     algoliaAttr:'taxonomySubcat', type:'conjunctive',  label:'Category',         disjunctive:false, maxValues:50,  searchable:false, sortBy:'count' },
  // Algolia hierarchical categories (lvl0-lvl6)
  { queryKey:'category',   algoliaAttr:'categories.lvl0', type:'hierarchical', label:'Browse',          disjunctive:false, maxValues:50,  searchable:false, sortBy:'count' },

  // ── Brand — disjunctive (OR multi-select) ───────────────────────────────────
  { queryKey:'brand',      algoliaAttr:'brand',          type:'disjunctive',  label:'Brand',            disjunctive:true,  maxValues:100, searchable:true,  sortBy:'count' },

  // ── Price ──────────────────────────────────────────────────────────────────────
  // Numeric range for slider (min/max filter)
  { queryKey:'price',         algoliaAttr:'price',          type:'range',        label:'Price',            disjunctive:false, maxValues:0,   searchable:false, sortBy:'count' },
  // Predefined price buckets (Amazon-style disjunctive string facet)
  { queryKey:'priceRange',    algoliaAttr:'priceRange',     type:'disjunctive',  label:'Price Range',      disjunctive:true,  maxValues:10,  searchable:false, sortBy:'alpha' },

  // ── Rating ──────────────────────────────────────────────────────────────────
  // Numeric range for slider
  { queryKey:'rating',        algoliaAttr:'avgRating',      type:'range',        label:'Avg. Rating',      disjunctive:false, maxValues:0,   searchable:false, sortBy:'count' },
  // Predefined rating buckets (Amazon-style: 4 Stars & Up etc.)
  { queryKey:'ratingBucket',  algoliaAttr:'ratingBucket',   type:'disjunctive',  label:'Customer Review',  disjunctive:true,  maxValues:5,   searchable:false, sortBy:'alpha' },

  // ── Discount ─────────────────────────────────────────────────────────────────
  // Numeric range for slider
  { queryKey:'discount',      algoliaAttr:'discountPercent', type:'range',       label:'Discount %',       disjunctive:false, maxValues:0,   searchable:false, sortBy:'count' },
  // Predefined discount buckets
  { queryKey:'discountRange', algoliaAttr:'discountRange',  type:'disjunctive',  label:'Discount',         disjunctive:true,  maxValues:5,   searchable:false, sortBy:'alpha' },

  // ── Colors + Sizes (from variants in scraped data) ───────────────────────────
  { queryKey:'color',      algoliaAttr:'colors',         type:'disjunctive',  label:'Color',            disjunctive:true,  maxValues:50,  searchable:false, sortBy:'count' },
  { queryKey:'size',       algoliaAttr:'sizes',          type:'disjunctive',  label:'Size',             disjunctive:true,  maxValues:50,  searchable:false, sortBy:'alpha' },

  // ── Availability booleans ────────────────────────────────────────────────────
  { queryKey:'inStock',    algoliaAttr:'inStock',       type:'boolean',      label:'In Stock',         disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'isPrime',    algoliaAttr:'isPrime',       type:'boolean',      label:'Prime Eligible',   disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'isFreeShip', algoliaAttr:'isFreeShip',   type:'boolean',      label:'Free Shipping',    disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },

  // ── Badge booleans (all from _flags in enriched scraped data) ─────────────────
  { queryKey:'onSale',       algoliaAttr:'isOnSale',       type:'boolean', label:'On Sale',           disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'bestSeller',   algoliaAttr:'isBestSeller',   type:'boolean', label:'Best Seller',       disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'trending',     algoliaAttr:'isTrending',      type:'boolean', label:'Trending',          disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'topRated',     algoliaAttr:'topRated',     type:'boolean', label:'Top Rated (4.5★+)', disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'amazonChoice', algoliaAttr:'isAmazonsChoice', type:'boolean', label:"Amazon's Choice",  disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'newRelease',   algoliaAttr:'isNewRelease',   type:'boolean', label:'New Release',       disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },
  { queryKey:'isDeal',       algoliaAttr:'isDeal',          type:'boolean', label:'Deals',             disjunctive:false, maxValues:2,   searchable:false, sortBy:'count' },

  // ── Dynamic attribute facets (from product_details → attrValues array) ────────
  // attrValues = ["bluetooth_version:5.3", "wattage:54 watts", "color:Black", ...]
  // Frontend uses category's CIL facet_config to show relevant keys per category
  { queryKey:'attrs',      algoliaAttr:'attrValues',    type:'disjunctive',  label:'Specifications',   disjunctive:true,  maxValues:500, searchable:false, sortBy:'count' },
]

export const DISJUNCTIVE_DIMENSIONS     = FACET_DIMENSIONS.filter(d => d.disjunctive)
export const ALL_ALGOLIA_FACET_ATTRS    = FACET_DIMENSIONS.filter(d => d.type !== 'range').map(d => d.algoliaAttr)

export const ALGOLIA_FACET_SETTINGS = [
  'searchable(brand)',
  'hierarchical(categories.lvl0)',
  'hierarchical(categories.lvl1)',
  'hierarchical(categories.lvl2)',
  'hierarchical(categories.lvl3)',
  'filterOnly(taxonomyDept)',
  'filterOnly(taxonomySubcat)',
  'searchable(colors)',
  'searchable(sizes)',
  // ── Boolean flags — names MUST match toAlgoliaRecord() in sync-algolia-pg.ts ──
  // Using filterOnly() (not searchable) since we only filter, never facet-count these.
  // is_active intentionally omitted: sync script only indexes active products.
  'filterOnly(inStock)',
  'filterOnly(isPrime)',
  'filterOnly(isFreeShip)',
  'filterOnly(isOnSale)',
  'filterOnly(isBestSeller)',
  'filterOnly(isTrending)',
  'filterOnly(topRated)',
  'filterOnly(isAmazonsChoice)',
  'filterOnly(isNewRelease)',
  'filterOnly(isDeal)',
  'filterOnly(featured)',
  'filterOnly(expressAvailable)',
  // attrValues: plain (no filterOnly/searchable wrapper) — disjunctive facet
  'attrValues',
]

export const ALGOLIA_NUMERIC_ATTRS = ['price','avgRating','reviewCount','discountPercent','createdAtMs']

export const SORT_INDEX_MAP: Record<string, string> = {
  price_asc:     '_price_asc',
  price_desc:    '_price_desc',
  rating_desc:   '_rating_desc',
  newest:        '_newest',
  bestselling:   '_bestselling',
  discount_desc: '_discount_desc',
}
