// src/algolia/facet-config.ts
// Canonical facet configuration — single source of truth for:
//   • FACET_DIMENSIONS       (used by buildFacetsResponse + DISJUNCTIVE_DIMENSIONS)
//   • ALGOLIA_FACET_SETTINGS (pushed to Algolia attributesForFaceting via configureIndex)
//   • ALGOLIA_NUMERIC_ATTRS  (numericAttributesForFiltering)
//   • SORT_INDEX_MAP         (replica index names)
//
// FIELD NAME CONTRACT — all algoliaAttr values MUST match sync-algolia-pg.ts.
// toRecord() in algolia.service.ts writes both canonical names AND backward-compat
// aliases so products indexed via either path are fully facetable.
//
// Canonical boolean names (sync-algolia-pg.ts source of truth):
//   isFreeShip · isOnSale · isBestSeller · isTrending · isNewRelease
//   inStock · isPrime · topRated · featured · expressAvailable · isDeal · isAmazonsChoice
//
// NEVER use filterOnly() on any attribute that needs a hit count in the UI.
// filterOnly() tells Algolia to skip counting — every such facet returns 0.

export type FacetType = 'disjunctive' | 'conjunctive' | 'boolean' | 'range' | 'hierarchical'

export interface FacetDimension {
  queryKey:    string        // URL / SearchQuery param key
  algoliaAttr: string        // Exact Algolia record field name
  type:        FacetType
  label:       string        // Human-readable sidebar label
  disjunctive: boolean       // true = OR multi-select (needs per-dim Algolia query)
  maxValues:   number        // maxValuesPerFacet for this dimension (0 = N/A for range)
  searchable:  boolean       // user can type to filter the facet list
  sortBy:      'count' | 'alpha'
}

export const FACET_DIMENSIONS: FacetDimension[] = [

  // ── Hierarchical / taxonomy ────────────────────────────────────────────────
  { queryKey: 'dept',        algoliaAttr: 'taxonomyDept',    type: 'hierarchical', label: 'Department',       disjunctive: false, maxValues: 50,  searchable: false, sortBy: 'count' },
  { queryKey: 'subcat',      algoliaAttr: 'taxonomySubcat',  type: 'conjunctive',  label: 'Category',         disjunctive: false, maxValues: 50,  searchable: false, sortBy: 'count' },
  // Flat slugs — used by buildFilters() and for flat category facet counts
  { queryKey: 'category',    algoliaAttr: 'category',        type: 'conjunctive',  label: 'Category',         disjunctive: false, maxValues: 50,  searchable: false, sortBy: 'count' },
  { queryKey: 'subcategory', algoliaAttr: 'subcategory',     type: 'conjunctive',  label: 'Subcategory',      disjunctive: false, maxValues: 50,  searchable: false, sortBy: 'count' },
  // Algolia hierarchical lvl0–lvl3 for drill-down category tree
  { queryKey: 'catLvl0',    algoliaAttr: 'categories.lvl0', type: 'hierarchical', label: 'Browse',           disjunctive: false, maxValues: 50,  searchable: false, sortBy: 'count' },

  // ── Brand — disjunctive OR multi-select ───────────────────────────────────
  { queryKey: 'brand',       algoliaAttr: 'brand',           type: 'disjunctive',  label: 'Brand',            disjunctive: true,  maxValues: 100, searchable: true,  sortBy: 'count' },

  // ── Price ─────────────────────────────────────────────────────────────────
  { queryKey: 'price',       algoliaAttr: 'price',           type: 'range',        label: 'Price',            disjunctive: false, maxValues: 0,   searchable: false, sortBy: 'count' },
  // priceRange: string bucket, for display counts only (not used as filter)
  { queryKey: 'priceRange',  algoliaAttr: 'priceRange',      type: 'disjunctive',  label: 'Price Range',      disjunctive: false, maxValues: 10,  searchable: false, sortBy: 'alpha' },

  // ── Rating ────────────────────────────────────────────────────────────────
  { queryKey: 'rating',        algoliaAttr: 'avgRating',     type: 'range',        label: 'Avg. Rating',      disjunctive: false, maxValues: 0,   searchable: false, sortBy: 'count' },
  // ratingBucket: string bucket for per-star-tier counts, not for numeric filtering
  { queryKey: 'ratingBucket',  algoliaAttr: 'ratingBucket',  type: 'disjunctive',  label: 'Customer Review',  disjunctive: false, maxValues: 6,   searchable: false, sortBy: 'alpha' },

  // ── Discount ──────────────────────────────────────────────────────────────
  { queryKey: 'discount',      algoliaAttr: 'discountPercent', type: 'range',      label: 'Discount %',       disjunctive: false, maxValues: 0,   searchable: false, sortBy: 'count' },
  // discountRange: string bucket for display counts only
  { queryKey: 'discountRange', algoliaAttr: 'discountRange',   type: 'disjunctive', label: 'Discount',        disjunctive: false, maxValues: 5,   searchable: false, sortBy: 'alpha' },

  // ── Colors + Sizes ────────────────────────────────────────────────────────
  { queryKey: 'color',       algoliaAttr: 'colors',          type: 'disjunctive',  label: 'Color',            disjunctive: true,  maxValues: 50,  searchable: false, sortBy: 'count' },
  { queryKey: 'size',        algoliaAttr: 'sizes',           type: 'disjunctive',  label: 'Size',             disjunctive: true,  maxValues: 50,  searchable: false, sortBy: 'alpha' },

  // ── Condition + Warehouse ─────────────────────────────────────────────────
  { queryKey: 'condition',   algoliaAttr: 'condition',       type: 'disjunctive',  label: 'Condition',        disjunctive: false, maxValues: 10,  searchable: false, sortBy: 'count' },
  { queryKey: 'warehouse',   algoliaAttr: 'warehouse',       type: 'disjunctive',  label: 'Ships From',       disjunctive: true,  maxValues: 20,  searchable: false, sortBy: 'count' },

  // ── Boolean availability flags ────────────────────────────────────────────
  // algoliaAttr names MUST match sync-algolia-pg.ts exactly
  { queryKey: 'inStock',          algoliaAttr: 'inStock',          type: 'boolean', label: 'In Stock',           disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'isPrime',          algoliaAttr: 'isPrime',          type: 'boolean', label: 'Prime Eligible',     disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'isFreeShip',       algoliaAttr: 'isFreeShip',       type: 'boolean', label: 'Free Shipping',      disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'expressAvailable', algoliaAttr: 'expressAvailable', type: 'boolean', label: 'Express Delivery',   disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },

  // ── Boolean badge flags ───────────────────────────────────────────────────
  { queryKey: 'onSale',       algoliaAttr: 'isOnSale',        type: 'boolean', label: 'On Sale',           disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'bestSeller',   algoliaAttr: 'isBestSeller',    type: 'boolean', label: 'Best Seller',       disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'trending',     algoliaAttr: 'isTrending',      type: 'boolean', label: 'Trending',          disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'topRated',     algoliaAttr: 'topRated',        type: 'boolean', label: 'Top Rated (4.5★+)', disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'amazonChoice', algoliaAttr: 'isAmazonsChoice', type: 'boolean', label: "Amazon's Choice",   disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'newRelease',   algoliaAttr: 'isNewRelease',    type: 'boolean', label: 'New Release',       disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'isDeal',       algoliaAttr: 'isDeal',          type: 'boolean', label: 'Deals',             disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },
  { queryKey: 'featured',     algoliaAttr: 'featured',        type: 'boolean', label: 'Featured',          disjunctive: false, maxValues: 2, searchable: false, sortBy: 'count' },

  // ── Dynamic attribute facets ──────────────────────────────────────────────
  // attrValues = ["bluetooth_version:5.3", "wattage:54 watts", ...]
  // Frontend uses the category's CIL facet_config to know which keys to show.
  { queryKey: 'attrs',       algoliaAttr: 'attrValues',      type: 'disjunctive',  label: 'Specifications',   disjunctive: true,  maxValues: 500, searchable: false, sortBy: 'count' },
]

// ── Derived exports ───────────────────────────────────────────────────────────

export const DISJUNCTIVE_DIMENSIONS = FACET_DIMENSIONS.filter((d) => d.disjunctive)

// All attributes Algolia should return facet counts for (excludes numeric range types)
export const ALL_ALGOLIA_FACET_ATTRS = FACET_DIMENSIONS
  .filter((d) => d.type !== 'range')
  .map((d) => d.algoliaAttr)

// ── attributesForFaceting ─────────────────────────────────────────────────────
// Pushed to Algolia via configureIndex() in algolia.service.ts.
//
// CRITICAL RULES:
//   • NEVER use filterOnly() for any attribute that shows a count in the UI.
//     filterOnly() tells Algolia to skip counting — every facet shows 0.
//   • Boolean field names MUST match sync-algolia-pg.ts (the canonical sync path).
//   • Bucket facets (priceRange, ratingBucket, discountRange) must be plain so
//     Algolia counts how many products fall into each bucket string value.

export const ALGOLIA_FACET_SETTINGS: string[] = [
  // ── Text / search-as-you-type facets ──────────────────────────────────────
  'searchable(brand)',
  'searchable(category)',         // flat slug — counts + filter-as-you-type
  'searchable(subcategory)',      // flat slug
  'searchable(taxonomyDept)',
  'searchable(taxonomySubcat)',
  'searchable(colors)',
  'searchable(sizes)',

  // ── Hierarchical category browsing ─────────────────────────────────────────
  'hierarchical(categories.lvl0)',
  'hierarchical(categories.lvl1)',
  'hierarchical(categories.lvl2)',
  'hierarchical(categories.lvl3)',

  // ── Dynamic attribute facets ───────────────────────────────────────────────
  'attrValues',

  // ── Bucket string facets — per-bucket hit counts ───────────────────────────
  // Computed on every record by both toRecord() and sync-algolia-pg.ts.
  // Algolia counts products per bucket string value automatically.
  'priceRange',
  'ratingBucket',
  'discountRange',

  // ── Miscellaneous filter dimensions ───────────────────────────────────────
  'condition',
  'warehouse',

  // ── Boolean flags ─────────────────────────────────────────────────────────
  // Plain — NOT filterOnly — so Algolia returns { 'true': N, 'false': M } counts.
  // Names match sync-algolia-pg.ts exactly. Do NOT rename these.
  'inStock',
  'isPrime',
  'isFreeShip',
  'isOnSale',
  'isBestSeller',
  'isTrending',
  'isNewRelease',
  'isDeal',
  'isAmazonsChoice',
  'topRated',
  'featured',
  'expressAvailable',
]

// ── numericAttributesForFiltering ─────────────────────────────────────────────
// Range slider filters (price, avgRating, discountPercent) and timestamp filter.
// reviewCount added to support "sort by most reviewed" replica ranking.
export const ALGOLIA_NUMERIC_ATTRS: string[] = [
  'price',
  'avgRating',
  'discountPercent',
  'reviewCount',
  'createdAtMs',
]

// ── Sort replica index suffixes ───────────────────────────────────────────────
export const SORT_INDEX_MAP: Record<string, string> = {
  price_asc:     '_price_asc',
  price_desc:    '_price_desc',
  rating_desc:   '_rating_desc',
  newest:        '_newest',
  bestselling:   '_bestselling',
  discount_desc: '_discount_desc',
}
