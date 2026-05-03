# Pikly Storefront API v2 — Complete Reference

> **For the frontend team.** This is the definitive contract for the new homepage API.
> Read this end-to-end before writing a single component.

---

## Overview

The v2 storefront API returns one response that contains **everything** the homepage needs to render. No secondary calls. No frontend-side data derivation. No layout logic in components.

**Endpoint:** `GET /api/homepage/storefront/v2`

**Auth:** Optional. Pass `Authorization: Bearer <token>` for personalized sections. Works without token for anonymous visitors.

---

## Top-Level Response Shape

```jsonc
{
  "success": true,
  "data": {
    "schema": "pikly_storefront_v2",
    "page": { /* SEO + campaign context */ },
    "nav": { /* departments + subcategory mega-menu */ },
    "sections": [ /* ORDERED array — map each to a component */ ],
    "personalization": { /* null for anon | full bundle for auth */ },
    "meta": { /* diagnostics, cache info, feature flags */ }
  },
  "meta": { "version": "5.0.0", "timestamp": "..." }
}
```

---

## `page` Object

```jsonc
{
  "title":       "Pikly — Shop Electronics, Fashion, Home & More",
  "description": "Shop millions of products at unbeatable prices.",
  "canonical":   "https://pikly.com",
  "ogImage":     null,

  // null = standard homepage
  // set  = active seasonal campaign (Mother's Day, Prime Day, etc.)
  "campaign": {
    "id":       "mothers-day-2026",
    "name":     "Mother's Day",
    "tagline":  "Shop Mother's Day deals",
    "startsAt": "2026-05-01T00:00:00Z",
    "endsAt":   "2026-05-12T23:59:59Z",
    "theme": {
      "primaryColor":   "#e91e8c",
      "accentColor":    "#ff9900",
      "heroBackground": "linear-gradient(135deg, #f8d7e8, #fff0f5)",
      "badgeLabel":     "Mother's Day Deal"
    }
  },

  // JSON-LD structured data — inject into <script type="application/ld+json">
  "structuredData": { "@context": "https://schema.org", "@type": "WebSite", ... }
}
```

---

## `nav` Object

```jsonc
{
  "departments": [
    {
      "slug":         "electronics",
      "name":         "Electronics",
      "link":         "/department/electronics",
      "icon":         null,
      "productCount": 1240,
      "subcategories": [
        { "slug": "headphones", "name": "Headphones", "link": "/category/headphones", "productCount": 84 },
        { "slug": "smartphones", "name": "Smartphones", "link": "/category/smartphones", "productCount": 210 }
      ]
    }
  ]
}
```

Use `nav.departments` for the top navigation bar and subcategories for the hover mega-menu.

---

## `sections[]` — The Core Contract

Iterate this array. Each item has a `type` field — instantiate the corresponding component. Do **not** re-sort (they are pre-ordered by `position`).

```tsx
sections.map(section => {
  switch (section.type) {
    case 'sub_nav_strip':       return <SubNavStrip       key={section.sectionId} section={section} />
    case 'hero_banner':         return <HeroBannerSlider  key={section.sectionId} section={section} />
    case 'editorial_campaign':  return <EditorialCampaign key={section.sectionId} section={section} />
    case 'quad_mosaic_row':     return <QuadMosaicRow     key={section.sectionId} section={section} />
    case 'product_carousel':    return <ProductCarousel   key={section.sectionId} section={section} />
    case 'deal_grid':           return <DealGrid          key={section.sectionId} section={section} />
    case 'bestseller_list':     return <BestsellerList    key={section.sectionId} section={section} />
    case 'also_viewed_grid':    return <AlsoViewedGrid    key={section.sectionId} section={section} />
    case 'continue_shopping':   return <ContinueShopping  key={section.sectionId} section={section} />
    case 'browsing_history':    return <BrowsingHistory   key={section.sectionId} section={section} />
  }
})
```

### `section.renderHints`

The backend controls layout. Components read `renderHints` — never hardcode layout values.

```jsonc
{
  "layout":           "carousel",    // carousel | grid | mosaic | hero | list | strip
  "columns":          { "desktop": 6, "tablet": 4, "mobile": 2 },
  "gap":              "sm",          // xs | sm | md | lg
  "backgroundColor":  null,          // null = inherit | CSS color value
  "textColor":        null,
  "lazy":             true,          // true = use IntersectionObserver
  "minItemsToRender": 3,             // skip section if fewer products
  "maxItemsToRender": 24,
  "showTitle":        true,
  "showSeeMore":      true,
  "cardSize":         "md"           // xs | sm | md | lg
}
```

### `section.visibility`

```jsonc
{
  "minBreakpoint": "xs",          // xs = always visible
  "audience":      "authenticated" // all | authenticated | anonymous
}
```

Hide personalized sections from anonymous users:
```tsx
if (section.visibility.audience === 'authenticated' && !isLoggedIn) return null
```

### `section.analytics`

Post to `/api/analytics/impression` when the section mounts:
```tsx
useEffect(() => {
  fetch('/api/analytics/impression', {
    method: 'POST',
    body: JSON.stringify({ token: section.analytics.impressionToken })
  })
}, [])
```

---

## Section Type Reference

### `hero_banner`

```jsonc
{
  "sectionId": "hero_main",
  "type": "hero_banner",
  "data": {
    "autoplayMs": 5000,       // ms between slides | null = manual only
    "aspectRatio": "21:9",
    "banners": [
      {
        "id": "banner_001",
        "position": 1,
        "title": "Explore Mother's Day deals",
        "subtitle": null,
        "eyebrow": "Limited Time",
        "desktopImage": "https://cdn.pikly.com/banners/md-2026-desktop.jpg",
        "mobileImage":  "https://cdn.pikly.com/banners/md-2026-mobile.jpg",
        "altText": "Mother's Day deals banner",
        "ctaText": "Shop now",
        "ctaLink": "/products?campaign=mothers-day-2026",
        "ctaStyle": "primary",
        "textAlignment": "left",
        "textColor": "dark",
        "overlayOpacity": 0.1,
        "badge": null
      }
    ]
  }
}
```

---

### `quad_mosaic_row` ← PRIMARY DISCOVERY PATTERN

Four department panels in a single row. Each panel contains 2–4 subcategory cells in a 2×2 grid. This is the core Amazon homepage layout unit.

```jsonc
{
  "sectionId": "quad_row_1",
  "type": "quad_mosaic_row",
  "data": {
    "panels": [
      {
        "panelId":     "panel_electronics",
        "heading":     "Top categories in Electronics",
        "priceFilter": null,
        "seeMoreText": "See all in Electronics",
        "seeMoreLink": "/department/electronics",
        "dept":        "Electronics",
        "deptSlug":    "electronics",
        "cells": [
          {
            "slug":          "headphones",
            "label":         "Headphones",
            "image":         "https://cdn.pikly.com/cats/headphones.jpg",
            "productImages": [],
            "link":          "/category/headphones",
            "altText":       "Headphones"
          },
          {
            "slug":          "smartphones",
            "label":         "Smartphones",
            "image":         null,
            // When category image is null, use productImages[0] as fallback
            "productImages": [
              "https://cdn.pikly.com/products/iphone-thumb.jpg",
              "https://cdn.pikly.com/products/samsung-thumb.jpg"
            ],
            "link":          "/category/smartphones",
            "altText":       "Smartphones"
          }
        ],
        "theme": {
          "backgroundColor": "#ffffff",
          "headingColor":    "#0f1111",
          "accentColor":     "#007185",
          "hasBorder":       true
        }
      }
      // ... 3 more panels
    ]
  }
}
```

**Rendering a mosaic cell:**
- If `cell.image` is set → use as the single cell image
- If `cell.image` is null → render a 2×2 grid of `cell.productImages`
- Cell links to `cell.link`

**With `priceFilter` set:**
```jsonc
{
  "heading": "New home arrivals under $50",
  "priceFilter": { "max": 50, "label": "under $50", "currency": "USD" }
}
```
Show the price badge prominently below the heading.

---

### `product_carousel`

```jsonc
{
  "sectionId": "carousel_featured",
  "type": "product_carousel",
  "title": "Amazon's Choice — Featured Picks",
  "subtitle": "Our editors' top picks across every department",
  "badge": "Amazon's Choice",
  "seeMoreLink": "/products?featured=true",
  "data": {
    "strategy": "featured",
    "strategyDept": null,
    "totalAvailable": 48,
    "pagination": {
      "nextCursor": "QjAwMVBRWFhYWA==",
      "prevCursor": null,
      "hasNextPage": true,
      "hasPrevPage": false,
      "limit": 24
    },
    "products": [ /* ProductCardV2[] — see below */ ]
  }
}
```

**Load more:**
```
GET /api/products?strategy=featured&cursor=QjAwMVBRWFhYWA==&limit=24
```

---

### `deal_grid`

```jsonc
{
  "sectionId": "deal_grid_today",
  "type": "deal_grid",
  "title": "Today's Deals",
  "data": {
    "refreshesAt": "2026-04-26T15:00:00.000Z",
    "viewAllLink": "/products?on_sale=true",
    "totalDeals": 384,
    "deals": [
      {
        // All ProductCardV2 fields +
        "deal": {
          "type":         "lightning_deal",
          "label":        "Lightning Deal",
          "originalPrice": 89.99,
          "dealPrice":     44.99,
          "savingsAmount": 45.00,
          "savingsPct":    50,
          "endsAt":       "2026-04-26T15:00:00.000Z",
          "claimedPct":   62,
          "claimedLabel": "62% claimed"
        },
        "dealPosition": 1
      }
    ]
  }
}
```

**Deal countdown:**
```tsx
const msLeft = new Date(deal.endsAt).getTime() - Date.now()
// render countdown timer from msLeft
```

**Progress bar:**
```tsx
<div style={{ width: `${deal.deal.claimedPct}%`, background: 'red' }} />
<span>{deal.deal.claimedLabel}</span>
```

---

### `bestseller_list`

```jsonc
{
  "sectionId": "bestseller_list_clothing",
  "type": "bestseller_list",
  "title": "Best Sellers in Clothing, Shoes & Jewelry",
  "data": {
    "categoryName": "Clothing, Shoes & Jewelry",
    "categorySlug": "clothing-shoes-jewelry",
    "categoryLink": "/category/clothing-shoes-jewelry",
    "products": [
      {
        // ProductCardV2 +
        "categoryRank": {
          "rank": 1,                           // → overlay "#1" badge on thumbnail
          "categoryName": "Clothing",
          "categoryLink": "/category/clothing"
        }
      }
    ]
  }
}
```

---

### `also_viewed_grid`

```jsonc
{
  "sectionId": "also_viewed_grid",
  "type": "also_viewed_grid",
  "title": "Customers who viewed items in your browsing history also viewed",
  "data": {
    "headline": "Customers who viewed items in your browsing history also viewed",
    "products": [ /* ProductCardV2[] */ ],
    "pagination": {
      "page":          1,
      "totalPages":    7,
      "totalItems":    126,
      "limit":         18,
      "hasNextPage":   true,
      "hasPrevPage":   false,
      "nextPageToken": "eyJwYWdlIjoyfQ==",
      "prevPageToken": null
    }
  }
}
```

**Pagination (Amazon "Page 1 of 7" pattern):**
```tsx
// Navigate to next page:
GET /api/homepage/storefront/v2?alsoViewedPage=2

// The response returns a new also_viewed_grid section with page 2 data.
// The rest of the layout is identical (from cache).
```

**Render "Page 1 of 7" copy using:**
```tsx
`Page ${pagination.page} of ${pagination.totalPages}`
```

---

### `editorial_campaign` (conditional — only when campaign is active)

```jsonc
{
  "sectionId": "campaign_mothers-day-2026",
  "type": "editorial_campaign",
  "title": "Explore Mother's Day deals",
  "data": {
    "campaignId":        "mothers-day-2026",
    "campaignName":      "Mother's Day",
    "headline":          "Explore Mother's Day deals",
    "subheadline":       null,
    "backgroundImage":   "https://cdn.pikly.com/campaigns/md-2026-bg.jpg",
    "backgroundGradient": null,
    "textColor":         "dark",
    "ctaText":           "Shop Mother's Day",
    "ctaLink":           "/products?campaign=mothers-day-2026",
    "tiles": [
      { "id": "t1", "label": "Apparel",  "image": "...", "link": "...", "badge": null },
      { "id": "t2", "label": "Shoes",    "image": "...", "link": "...", "badge": null },
      { "id": "t3", "label": "Jewelry",  "image": "...", "link": "...", "badge": null },
      { "id": "t4", "label": "Handbags", "image": "...", "link": "...", "badge": null }
    ]
  }
}
```

---

### `continue_shopping` / `browsing_history` (auth only)

When authenticated, these are fully populated.
When anonymous, `data.products` is `[]` — render sign-in CTA or nothing.

```jsonc
{
  "sectionId": "continue_shopping",
  "type": "continue_shopping",
  "title": "Continue shopping for",
  "visibility": { "audience": "authenticated" },
  "data": {
    "strategy": "continue",
    "totalAvailable": 8,
    "pagination": null,
    "products": [ /* ProductCardV2[] of recently viewed, not purchased */ ]
  }
}
```

---

## `ProductCardV2` — Complete Field Reference

Every product in every section uses this exact shape. No exceptions.

```jsonc
{
  // ── Identity ──────────────────────────────────────────────────────────────
  "asin": "B09G9FPHY6",
  "slug": "sony-wh1000xm5-b09g9fphy6-3f8a2b",

  // ── Content ───────────────────────────────────────────────────────────────
  "title":      "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
  "brand":      "Sony",
  "thumbnail":  "https://cdn.pikly.com/products/B09G9FPHY6/main.jpg",
  "thumbnailAlt": "https://cdn.pikly.com/products/B09G9FPHY6/hover.jpg",  // null if no second image

  // ── Taxonomy ──────────────────────────────────────────────────────────────
  "dept":   "Electronics",
  "subcat": "Headphones",

  // ── Pricing ───────────────────────────────────────────────────────────────
  "price":         279.99,
  "originalPrice": 399.99,        // null if not on sale
  "discountPct":   30,            // 0 if no discount
  "savingsAmount": 120.00,        // null if not on sale
  "unitPrice":     null,          // "$0.50/oz" — null for most products
  "coupon":        "Clip 15% coupon",  // null if no coupon

  // ── Ratings ───────────────────────────────────────────────────────────────
  "avgRating":          4.6,
  "reviewCount":        23841,
  "ratingDistribution": null,     // only in product detail endpoint

  // ── Commerce signals ──────────────────────────────────────────────────────
  "isPrime":        true,
  "purchaseSignal": "2k+ bought in past month",   // null if < 50/month

  "stockSignal": {
    "status": "in_stock",        // in_stock | low_stock | last_few | out_of_stock
    "label":  null               // "Only 3 left in stock – order soon" when low
    "count":  null               // exact number when ≤ 10
  },

  // ── Delivery promise ──────────────────────────────────────────────────────
  // THE #1 conversion driver — render prominently below price.
  "deliveryPromise": {
    "headline":    "FREE delivery Saturday, Apr 26",   // render verbatim
    "isFree":      true,
    "isPrime":     true,
    "cutoffLabel": "Order within 6 hrs 15 mins",       // null for non-prime
    "dateRange":   null
  },

  // ── Badges ────────────────────────────────────────────────────────────────
  // Render at most 3. Each badge.type drives a distinct visual style.
  "badges": [
    {
      "type":     "amazons_choice",   // drives orange border + logo mark
      "label":    "Amazon's Choice",
      "subLabel": "in Wireless Headphones"
    },
    {
      "type":     "best_seller",      // drives orange "#1 Best Seller" banner
      "label":    "Best Seller",
      "subLabel": null
    }
  ],

  // ── Category rank ─────────────────────────────────────────────────────────
  // Render as "#1 Best Seller in Headphones" — null if not ranked
  "categoryRank": {
    "rank":         1,
    "categoryName": "Over-Ear Headphones",
    "categoryLink": "/category/over-ear-headphones"
  },

  // ── Deal ──────────────────────────────────────────────────────────────────
  // null = not a deal
  "deal": {
    "type":          "lightning_deal",
    "label":         "Lightning Deal",
    "originalPrice": 399.99,
    "dealPrice":     279.99,
    "savingsAmount": 120.00,
    "savingsPct":    30,
    "endsAt":        "2026-04-26T15:00:00.000Z",   // compute countdown from this
    "claimedPct":    62,                            // render as red progress bar
    "claimedLabel":  "62% claimed"
  },

  // ── Sponsored ─────────────────────────────────────────────────────────────
  "sponsored":      false,
  "sponsoredLabel": null,     // "Sponsored" or "Ad" when true

  // ── Analytics — REQUIRED ──────────────────────────────────────────────────
  "impressionToken": "eyJhc2luIjoiQjA5RzlGUEhZNiIsInNlY3Rpb25JZC...",
  "clickUrl":        "/products/sony-wh1000xm5-b09g9fphy6?ref=carousel_featured&strategy=featured"
  //                  ↑ Always use this — attribution params are embedded
}
```

### Badge Type → Visual Spec

| `type` | Color | Shape | Icon |
|---|---|---|---|
| `amazons_choice` | Orange `#E37C16` | Rounded pill | ✓ Amazon logo |
| `best_seller` | Orange `#E37C16` | Left-anchored banner | `#1` prefix |
| `new_release` | Green `#067D62` | Rounded pill | Spark icon |
| `trending` | Purple `#7B2D8B` | Rounded pill | 📈 |
| `prime` | Navy `#00A8E0` | Inline | Prime logo |
| `deal` / `lightning_deal` | Red `#CC0C39` | Rounded pill | 🏷️ |
| `top_rated` | Gold `#F5A623` | Rounded pill | ⭐ |
| `free_shipping` | Teal `#007185` | Inline text | — |
| `climate_pledge` | Green | Rounded pill | 🌿 |

---

## `meta` Object

```jsonc
{
  "schema":      "pikly_storefront_v2",
  "apiVersion":  "2.0.0",
  "generatedAt": "2026-04-25T14:32:11.421Z",

  // Cache info
  "cacheHit":          true,
  "cacheTier":         "L1",        // L1 | L2 | none
  "cacheTtlRemaining": null,

  "sectionCount": 18,
  "productCount": 312,              // total product cards in response

  // null in production
  "timing": [{ "sectionId": "__total", "buildMs": 3, "strategy": "composite" }],

  "personalizationContext": {
    "userId":                    "usr_abc123",
    "isAuthenticated":           true,
    "hasHistory":                true,
    "personalizedSectionCount":  4
  },

  "featureFlags": {
    "dealCountdownEnabled":       true,
    "editorialCampaignEnabled":   true,
    "subNavEnabled":              true,
    "quadMosaicEnabled":          true
  },

  "activeCampaignId": "mothers-day-2026"
}
```

---

## `personalization` Object (auth only)

```jsonc
{
  "userId":            "usr_abc123",
  "hasHistory":        true,
  "topAffinityDepts":  ["Electronics", "Clothing, Shoes & Jewelry"],

  "continueShoppingFor": {
    "label":    "Continue shopping for",
    "strategy": "continue",
    "count":    6,
    "products": [ /* ProductCardV2[] */ ]
  },

  "basedOnBrowsingHistory": {
    "label":    "Based on your browsing history",
    "strategy": "history_based",
    "count":    12,
    "products": [ /* ProductCardV2[] */ ]
  },

  "alsoViewed": {
    "label":    "Customers also viewed",
    "strategy": "also_viewed",
    "count":    18,
    "products": [ /* ProductCardV2[] */ ]
  },

  "moreToConsider": {
    "label":    "More items to consider",
    "strategy": "more_to_consider",
    "count":    12,
    "products": [ /* ProductCardV2[] */ ]
  },

  "computedAt": "2026-04-25T14:32:10.918Z",
  "fromCache":  true
}
```

---

## Implementation Checklist

### Required for launch

- [ ] Implement `section.visibility.audience` filtering client-side
- [ ] Implement `section.renderHints.lazy` — use `IntersectionObserver` for sections where `lazy: true`
- [ ] Implement `section.renderHints.minItemsToRender` — skip section if `products.length < min`
- [ ] Post `section.analytics.impressionToken` on mount for every section
- [ ] Post `product.impressionToken` on mount for every visible product card
- [ ] Use `product.clickUrl` for ALL product links — never construct URLs manually
- [ ] Render `deliveryPromise.headline` verbatim — do not reformat
- [ ] Render `stockSignal.label` in red when `status` is `low_stock` or `last_few`
- [ ] Show `purchaseSignal` below price when non-null
- [ ] Render deal countdown from `deal.endsAt`
- [ ] Render claimed progress bar from `deal.claimedPct`
- [ ] Handle `priceFilter` in quad mosaic panels — show "under $50" sub-heading
- [ ] Inject `page.structuredData` into `<script type="application/ld+json">`
- [ ] Apply `page.campaign.theme` overrides when campaign is active
- [ ] Render "Page N of M" in `also_viewed_grid` using `pagination.page` / `pagination.totalPages`

### Personalization

- [ ] Authenticated: pass `Authorization: Bearer <token>` — personalized sections auto-populate
- [ ] Anonymous: skip sections where `visibility.audience === 'authenticated'`
- [ ] Post-login: call `GET /homepage/storefront/v2` with token to get personalized layout
- [ ] After purchase / wishlist add: invalidate personalization via `GET /homepage/personalized/v2`

### Performance

- [ ] SSR the first 4 sections (above-fold) — `renderHints.lazy: false`
- [ ] Client-side render sections 5+ with `IntersectionObserver`
- [ ] Cache the anonymous response at CDN edge — `Surrogate-Control: max-age=300`
- [ ] For auth users: cache at CDN with `Vary: Authorization`

---

## Query Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `alsoViewedPage` | integer | 1 | Paginate the `also_viewed_grid` section |

---

## Deprecated Endpoints

| Old Endpoint | Replacement | Retire By |
|---|---|---|
| `GET /homepage/storefront` | `GET /homepage/storefront/v2` | 2025-09-01 |
| `GET /homepage/personalized` | Embedded in v2 storefront | 2025-09-01 |
| `GET /homepage` | `GET /homepage/storefront/v2` | 2025-12-01 |

---

## Changelog

### v2.0.0 (current)
- `quad_mosaic_row` replaces `category_grid` + `dept_spotlight` — 4-panel Amazon layout
- `deal_grid` — countdown + % claimed progress bars
- `editorial_campaign` — seasonal campaign sections
- `bestseller_list` — ranked strip with #N badge overlay
- `also_viewed_grid` — paginated 6-col grid with "Page N of M"
- `sub_nav_strip` — horizontal dept quick-links after hero
- `ProductCardV2` — `deliveryPromise`, `stockSignal`, `purchaseSignal`, `deal`, `badges` typed
- Single-request merge of base layout + personalization for auth users
- All sections carry `renderHints` — frontend has zero layout hardcoding
- Analytics tokens baked per-card and per-section
- `page.campaign` + `page.structuredData` — SEO and theming out of the box
- `nav` — full department + subcategory mega-menu in every response

### v1.0.0 (deprecated)
- Basic `hero_banner`, `category_grid`, `product_carousel`, `dept_spotlight`
- Flat product shape from `toCard()`
- No delivery promise, no deal info, no badges, no render hints
