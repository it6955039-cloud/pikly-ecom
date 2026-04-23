# API Reference

Base URL: `http://localhost:3000`
All endpoints: `/api/*` (except `/health`)

Authentication: `Authorization: Bearer <jwt_token>`

---

## Authentication

### POST /api/auth/register
Create a new user account.

```json
{ "email": "user@example.com", "password": "Secret123!", "firstName": "Jane", "lastName": "Doe" }
```

### POST /api/auth/login
Authenticate and receive tokens.

```json
{ "email": "user@example.com", "password": "Secret123!" }
```

**Response:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "uuid", "email": "...", "role": "customer" }
}
```

### POST /api/auth/refresh
Exchange a refresh token for a new access token.

### POST /api/auth/logout
Revoke the current session.

### POST /api/auth/forgot-password
Send a password reset email.

### POST /api/auth/reset-password
Reset password using the emailed token.

---

## Products

### GET /api/products
Search and filter products via Algolia.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `q` | string | Search query |
| `dept` | string | Filter by department (taxonomy) |
| `subcat` | string | Filter by subcategory |
| `brand` | string | Filter by brand (multi-value: `brand=Nike,Adidas`) |
| `minPrice` | number | Minimum price |
| `maxPrice` | number | Maximum price |
| `rating` | number | Minimum average rating (e.g. `4`) |
| `discount` | number | Minimum discount percentage |
| `color` | string | Filter by color |
| `size` | string | Filter by size |
| `inStock` | boolean | Only in-stock products |
| `isPrime` | boolean | Prime eligible only |
| `freeShipping` | boolean | Free shipping only |
| `onSale` | boolean | On-sale products only |
| `bestSeller` | boolean | Best sellers only |
| `trending` | boolean | Trending products only |
| `sort` | string | `price_asc`, `price_desc`, `rating_desc`, `newest`, `bestselling`, `discount_desc` |
| `page` | number | Page number (default: 1) |
| `limit` | number | Results per page (default: 20, max: 100) |

### GET /api/products/featured
Amazon's Choice + best seller products.

### GET /api/products/bestsellers
Best seller products sorted by rating.

### GET /api/products/new-arrivals
New release products sorted by created date.

### GET /api/products/trending
Trending products.

### GET /api/products/top-rated
Products with ≥ 4.5 stars and ≥ 100 reviews.

### GET /api/products/on-sale
Products with ≥ 10% discount.

### GET /api/products/search/suggestions?q=:query
Autocomplete suggestions (Fuse.js). Returns up to 8 results.

### GET /api/products/:slug
Full product detail by slug or ASIN.

**Response shape:**
```json
{
  "success": true,
  "data": {
    "asin": "B001A2VBUU",
    "slug": "product-name-b001a2vbuu-abc123",
    "source": "pikly",
    "data": {
      "product_results": {},
      "purchase_options": {},
      "protection_plan": [],
      "item_specifications": {},
      "about_item": [],
      "bought_together": [],
      "related_products": [],
      "videos": [],
      "product_details": {},
      "reviews_information": {},
      "category": [],
      "accordionContent": [],
      "shippingFees": {},
      "bestsellers_rank": []
    },
    "enrichment_source_data": {},
    "_taxonomy": {
      "department": "Beauty and Personal Care",
      "subcategory": "Toners & Astringents"
    },
    "_flags": {
      "isBestSeller": true,
      "isAmazonsChoice": true,
      "isPrime": true,
      "isOnSale": true,
      "inStock": true
    },
    "_computed": {
      "title": "Product Title",
      "brand": "Brand Name",
      "mainImage": "https://...",
      "thumbnails": ["https://..."],
      "price": 14.99,
      "originalPrice": 19.99,
      "discountPct": 25,
      "avgRating": 4.6,
      "reviewCount": 1820,
      "badges": ["Best Seller", "Prime"],
      "inStock": true,
      "isPrime": true,
      "stockStatus": "in_stock",
      "deliveryEstimate": {
        "options": ["FREE delivery Saturday"],
        "isFree": true,
        "isPrime": true,
        "soldBy": "Amazon.com",
        "shipsFrom": "Amazon"
      },
      "relatedProducts": [],
      "frequentlyBoughtWith": []
    }
  }
}
```

### GET /api/products/:slug/reviews
Paginated reviews for a product.

**Query params:** `page`, `limit`, `rating` (1-5), `sort` (`newest`, `helpful`, `rating_high`, `rating_low`), `verified` (boolean)

### POST /api/products/:slug/reviews
Submit a review. Requires authentication.

```json
{ "title": "Great product", "body": "Really impressed with the quality.", "rating": 5 }
```

---

## Departments

### GET /api/departments
All departments with aggregated catalog statistics. Computed from in-memory product cache — zero DB queries.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "slug": "beauty-and-personal-care",
      "name": "Beauty and Personal Care",
      "productCount": 412,
      "subcategories": [
        {
          "slug": "toners-astringents",
          "name": "Toners & Astringents",
          "productCount": 48,
          "priceRange": { "min": 8.99, "max": 64.99 },
          "avgRating": 4.3
        }
      ],
      "topBrands": ["CeraVe", "Neutrogena", "La Roche-Posay"],
      "priceRange": { "min": 2.99, "max": 189.99 },
      "avgRating": 4.2,
      "thumbnail": "https://...",
      "flags": {
        "bestSellerCount": 12,
        "onSaleCount": 87,
        "primeCount": 398,
        "trendingCount": 23
      }
    }
  ],
  "meta": { "total": 14 }
}
```

### GET /api/departments/:slug
Single department with full subcategory breakdown and top 8 featured products.

Accepts the department slug (`beauty-and-personal-care`) or the raw department name.

### GET /api/departments/:slug/subcategories/:subSlug/products
Paginated product listing for a specific department + subcategory.

**Query params:** `page` (default: 1), `limit` (default: 20, max: 100)

---

## Categories

### GET /api/categories
Full category tree (hierarchical). Returns all active categories with their children nested.

### GET /api/categories/featured
Featured categories only (top-level departments with `is_featured = true`).

### GET /api/categories/:slug
Single category with its direct children. Throws 404 if not found.

### GET /api/categories/:slug/products
Products filtered by category slug. Matches on `cat_lvl0` or `taxonomy_dept`.

**Query params:** `page`, `limit`

---

## Homepage

### GET /api/homepage
Complete homepage data in a single request: banners, featured products, best sellers, trending, new arrivals, on-sale, top-rated, featured categories, department spotlights. Cached in-memory for 5 minutes.

### GET /api/homepage/banners
Active homepage banners only. Filter by `?position=hero|secondary|sidebar`.

### GET /api/homepage/widgets
**Page composition API** — dynamic, admin-configurable alternative to `GET /api/homepage`.

Optionally authenticated (`Authorization: Bearer <token>`). Authenticated users also receive widgets with `target="authenticated"`. Anonymous visitors receive `target="all"` and `target="anonymous"` widgets only.

Each item in the response array:
```json
{
  "id": "hw_featured",
  "type": "product_carousel",
  "title": "Featured Picks",
  "subtitle": null,
  "badge": null,
  "position": 2,
  "target": "all",
  "data": { "products": [...], "strategy": "featured", "count": 12 }
}
```

Widget types and their `data` shape:

| type | data keys |
|---|---|
| `hero_banner` | `{ banners[], bannerPosition }` |
| `product_carousel` | `{ products[], strategy, count }` |
| `category_grid` | `{ cells[], filterDept, filterMaxPrice, cellCount }` |
| `dept_spotlight` | `{ dept, products[], count }` |
| `campaign` | `{ products[], strategy, filterDept, count }` |

Cached in-memory per audience (auth/anon) for 5 minutes. Invalidated via Redis pub/sub on any admin mutation.

### GET /api/homepage/personalized
**Requires authentication.** Returns four personalized sections for the authenticated user.

| Section | Strategy |
|---|---|
| `continueShoppingFor` | Recently viewed items not yet purchased |
| `basedOnBrowsingHistory` | Top-rated products from user's most-visited departments (Wilson score: `rating × log(reviews)`) |
| `alsoViewed` | Item-item collaborative filtering via SQL co-occurrence |
| `moreToConsider` | Trending products in user's affinity departments |

All sections fall back to global signals when the user has no browsing history. Results are cached per-user in Redis for 5 minutes, evicted automatically on new product views.

**Response:**
```json
{
  "success": true,
  "data": {
    "continueShoppingFor":    { "label": "Continue Shopping For",         "strategy": "continue_shopping",       "products": [...], "count": 8  },
    "basedOnBrowsingHistory": { "label": "Based on Your Browsing History","strategy": "history_dept_affinity",   "products": [...], "count": 16 },
    "alsoViewed":             { "label": "Customers Also Viewed",         "strategy": "collaborative_filtering", "products": [...], "count": 12 },
    "moreToConsider":         { "label": "More to Consider",              "strategy": "more_to_consider",        "products": [...], "count": 16 },
    "meta": { "userId": "uuid", "hasHistory": true, "topDepts": ["Electronics"], "computedAt": "...", "fromCache": false }
  }
}
```

---

## Cart

Carts are session-based. Pass `X-Session-ID` header or include in request. Optionally linked to a user account.

### GET /api/cart
Retrieve current cart with line items and order summary.

### POST /api/cart/add
Add a product to the cart.

```json
{ "productId": "B001A2VBUU", "quantity": 2 }
```

### PATCH /api/cart/item
Update item quantity.

```json
{ "productId": "B001A2VBUU", "quantity": 3 }
```

### DELETE /api/cart/item
Remove an item from the cart.

### POST /api/cart/apply-coupon
Apply a discount coupon.

```json
{ "code": "SAVE10" }
```

### DELETE /api/cart/coupon
Remove the applied coupon.

### POST /api/cart/merge
Merge a guest cart into an authenticated user's cart after login.

```json
{ "guestSessionId": "sess_abc123" }
```

---

## Orders

Requires authentication.

### GET /api/orders
List orders for the authenticated user. Sorted by created date desc.

### POST /api/orders
Place an order from the current cart.

### GET /api/orders/:id
Single order detail.

---

## Wishlist

Requires authentication.

### GET /api/wishlist
User's saved products with full product cards.

### POST /api/wishlist/:asin
Add a product to the wishlist.

### DELETE /api/wishlist/:asin
Remove a product from the wishlist.

### POST /api/wishlist/:asin/toggle
Toggle wishlist status (add if absent, remove if present).

---

## Compare

### GET /api/compare
Current compare list (max 4 products) for this session.

### POST /api/compare/add
Add a product to the compare list.

### DELETE /api/compare/:asin
Remove a product from the compare list.

### DELETE /api/compare
Clear the entire compare list.

---

## Recently Viewed

Requires authentication.

### GET /api/recently-viewed
Products the user has recently viewed (most recent first).

### POST /api/recently-viewed/:asin
Record a product view.

### DELETE /api/recently-viewed
Clear the recently viewed list.

---

## Users

Requires authentication.

### GET /api/users/profile
Current user's profile.

### PATCH /api/users/profile
Update profile fields (name, phone, avatar).

### POST /api/users/address
Add a shipping address.

### DELETE /api/users/address/:id
Remove a shipping address.

---

## Health

### GET /health
Public liveness probe. Returns `{ "status": "ok" }`.

### GET /health/detail
Admin-only readiness probe. Returns heap usage, product/category counts, uptime.

---

## Admin Endpoints

All admin endpoints require `Authorization: Bearer <admin_jwt>`.

### Products
- `GET /api/admin/products` — paginated product list with search
- `POST /api/admin/products` — create a product manually
- `PATCH /api/admin/products/:asin` — update product fields
- `DELETE /api/admin/products/:asin` — soft-delete (sets `is_active = false`)
- `POST /api/admin/products/bulk-import` — import from JSONL payload
- `POST /api/admin/products/invalidate` — flush in-memory product cache

### Categories
- `GET /api/admin/categories`
- `POST /api/admin/categories`
- `PATCH /api/admin/categories/:id`
- `DELETE /api/admin/categories/:id`
- `POST /api/admin/categories/refresh-counts` — recalculate `product_count` from store.products

### Orders
- `GET /api/admin/orders` — all orders with filters
- `PATCH /api/admin/orders/:id/status` — update order status
- `POST /api/admin/orders/:id/refund`

### Users
- `GET /api/admin/users` — paginated user list
- `PATCH /api/admin/users/:id` — update user (role, is_active)

### Coupons
- `GET /api/admin/coupons`
- `POST /api/admin/coupons`
- `PATCH /api/admin/coupons/:id`
- `DELETE /api/admin/coupons/:id`

### Banners
- `GET /api/admin/banners`
- `POST /api/admin/banners`
- `PATCH /api/admin/banners/:id`
- `DELETE /api/admin/banners/:id`

### Homepage Widgets
Admin CRUD + reorder for homepage widget slots.

- `GET /api/admin/homepage-widgets` — list all slots (active + inactive) ordered by position
- `POST /api/admin/homepage-widgets` — create a new slot
- `PATCH /api/admin/homepage-widgets/reorder` — atomic bulk reorder (transaction); body: `{ "ids": ["hw_hero", "hw_featured", ...] }`
- `GET /api/admin/homepage-widgets/:id` — single slot
- `PATCH /api/admin/homepage-widgets/:id` — update any field
- `PATCH /api/admin/homepage-widgets/:id/toggle` — flip `is_active`
- `DELETE /api/admin/homepage-widgets/:id` — hard delete

**Create / Update body fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | create only | `hero_banner` \| `product_carousel` \| `category_grid` \| `dept_spotlight` \| `campaign` |
| `config` | object | create only | Type-specific config — see below |
| `title` | string | — | Display title |
| `subtitle` | string | — | Display subtitle |
| `badge` | string | — | Badge label e.g. `"Limited Time"` |
| `position` | integer | — | Display order (lower = higher). Use reorder endpoint for bulk operations |
| `isActive` | boolean | — | Defaults to `true` |
| `target` | string | — | `all` \| `authenticated` \| `anonymous` |

**Config examples by type:**
```json
{ "type": "hero_banner",      "config": { "bannerPosition": "hero" } }
{ "type": "product_carousel", "config": { "strategy": "bestsellers", "limit": 12 } }
{ "type": "product_carousel", "config": { "strategy": "by_dept", "dept": "Electronics", "limit": 8 } }
{ "type": "category_grid",    "config": { "dept": "Home & Kitchen", "maxPrice": 50, "limit": 4, "productsPerCell": 2 } }
{ "type": "dept_spotlight",   "config": { "dept": "Beauty", "limit": 4 } }
{ "type": "campaign",         "config": { "strategy": "on_sale", "dept": "Fashion", "limit": 8 } }
```

### Analytics
- `GET /api/admin/analytics/overview` — product counts, order totals, revenue
- `GET /api/admin/analytics/quality` — CIL quality score summary

### CIL (Catalog Intelligence Layer)
See **[CIL.md](CIL.md)** for details.

- `GET /api/admin/cil/health`
- `GET /api/admin/cil/families`
- `POST /api/admin/cil/families/generate`
- `POST /api/admin/cil/families/refresh-schema`
- `POST /api/admin/cil/accordion/preview`
- `POST /api/admin/cil/jobs/accordion`
- `POST /api/admin/cil/jobs/quality-scoring`
- `GET /api/admin/cil/jobs`
- `GET /api/admin/cil/jobs/:jobId`
- `GET /api/admin/cil/quality/summary`
- `GET /api/admin/cil/quality`
- `GET /api/admin/cil/facets`
- `GET /api/admin/cil/facets/:path`
- `GET /api/admin/cil/cache/stats`
