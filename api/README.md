# Pikly Store API v3

A full-featured eCommerce REST API built with **NestJS + TypeScript**, backed by **Neon PostgreSQL**, **Redis (Upstash)**, and **Algolia**. Zero MongoDB. Zero Mongoose.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20, TypeScript 5 |
| Framework | NestJS 10 |
| Database | Neon PostgreSQL (`@neondatabase/serverless`) |
| Cache / Pub-Sub | Redis via Upstash (ioredis) |
| Search | Algolia |
| AI Enrichment | Google Gemini Flash (free tier) |
| Image Storage | Cloudinary |
| Email | Nodemailer + Gmail SMTP |

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill: DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET

# 3. Run migrations (requires direct Neon connection string, port 5432)
psql $DIRECT_NEON_URL < sql/000_full_schema.sql

# 4. Seed data
npm run seed

# 5. (Optional) Sync Algolia search index
npm run sync-algolia

# 6. Start dev server
npm run start:dev
# → http://localhost:3000/api/v1
# → Swagger: http://localhost:3000/api/v1/docs  (set SWAGGER_ENABLED=true)
```

---

## Environment Variables

See `.env.example` for the full list. Minimum required to start:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.region.aws.neon.tech:6543/pikly?sslmode=require
REDIS_URL=rediss://:password@your-upstash-host:6380
JWT_SECRET=<min 32 chars random>
JWT_REFRESH_SECRET=<different min 32 chars random>
```

> Use port **6543** (Neon pooler) in `DATABASE_URL` for the app.  
> Use port **5432** (Neon direct) only for `psql` migrations.

---

## Database

All data lives in a single Neon PostgreSQL database with multiple schemas:

| Schema | Contents |
|---|---|
| `store.*` | Users, products, orders, cart, coupons, wishlists, reviews, banners, webhooks |
| `catalog.*` | LTREE taxonomy, EAV attributes, accordion content |
| `cil.*` | AI quality scores, attribute families, facet configs |
| `search.*` | Algolia sync state, materialized views |

---

## API Endpoints

Base path: `/api/v1`

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Register (sends verification email) |
| GET  | `/auth/verify-email?token=` | — | Verify email |
| POST | `/auth/resend-verification` | — | Resend verification email |
| POST | `/auth/login` | — | Login → `accessToken` (15 min) + `refreshToken` (30 days) |
| POST | `/auth/refresh` | — | Rotate refresh token |
| POST | `/auth/logout` | ✅ JWT | Revoke access + refresh tokens |
| POST | `/auth/forgot-password` | — | Send reset email |
| POST | `/auth/reset-password` | — | Reset with token |
| POST | `/auth/change-password` | ✅ JWT | Change while logged in |

### Products
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/products` | — | Search, filter, paginate (Algolia) |
| GET | `/products/featured` | — | Amazon's Choice + best sellers |
| GET | `/products/bestsellers` | — | Best sellers |
| GET | `/products/trending` | — | Trending (10K+ bought/month) |
| GET | `/products/new-arrivals` | — | New releases |
| GET | `/products/top-rated` | — | 4.5★ with 100+ reviews |
| GET | `/products/on-sale` | — | 10%+ discount |
| GET | `/products/search/suggestions?q=` | — | Autocomplete |
| GET | `/products/:slug` | — | Full product detail + related |
| GET | `/products/:slug/reviews` | — | Paginated reviews |
| POST | `/products/:slug/reviews` | ✅ JWT | Submit review |

### Cart (session-based, no auth except merge)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/cart?sessionId=` | — | Get cart |
| POST | `/cart/add` | — | Add item |
| PATCH | `/cart/update` | — | Update quantity |
| DELETE | `/cart/remove` | — | Remove item |
| POST | `/cart/coupon` | — | Apply coupon |
| DELETE | `/cart/coupon?sessionId=` | — | Remove coupon |
| POST | `/cart/merge` | ✅ JWT | Merge guest cart after login |

### Orders
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/orders/create` | ✅ JWT | Place order from cart |
| GET  | `/orders` | ✅ JWT | My orders (filterable by status) |
| GET  | `/orders/:orderId` | ✅ JWT | Single order |
| PATCH | `/orders/:orderId/cancel` | ✅ JWT | Cancel (pending/confirmed only) |
| GET  | `/orders/:orderId/track` | ✅ JWT | Timeline + tracking info |

### Users
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users/profile` | ✅ JWT | Get profile |
| PATCH | `/users/profile` | ✅ JWT | Update profile |
| GET/POST/PATCH/DELETE | `/users/addresses/:id` | ✅ JWT | Address book |
| GET | `/users/loyalty` | ✅ JWT | Loyalty points balance |
| POST | `/users/loyalty/redeem` | ✅ JWT | Redeem points (100 = $1.00) |

### Admin (all require `role: admin`)
- `GET/POST/PATCH/DELETE /admin/products`
- `GET/POST/PATCH/DELETE /admin/categories`
- `GET/PATCH /admin/orders` — list, update status, add tracking
- `GET/PATCH/DELETE /admin/users` — ban, unban, change role
- `GET/POST/PATCH/DELETE /admin/coupons`
- `GET/POST/PATCH/DELETE /admin/banners`
- `GET /admin/analytics/revenue` — total, AOV, by date range
- `GET /admin/analytics/revenue-by-day` — daily series (default 30 days)
- `GET /admin/analytics/top-products` — by revenue
- `GET /admin/analytics/users` — registration stats
- `GET /admin/analytics/orders-by-status`
- `POST /admin/bulk/products` — activate/deactivate/delete up to 100
- `POST /admin/bulk/orders` — bulk status update up to 100

### Other
- `GET /health` — public liveness
- `GET /health/detail` — admin: heap, counts, uptime
- `GET /homepage` — full homepage payload (cached)
- `POST /compare` — compare 2–4 products
- `GET/POST /wishlist` — wishlist (JWT)
- `GET/POST /recently-viewed` — recently viewed (JWT)
- `GET /categories` — full tree
- `GET /coupons/validate?code=` — validate a coupon
- `GET/POST/DELETE /webhooks` — admin: register HTTPS webhooks

---

## Security

- JWT access tokens (15 min) + refresh tokens (30 days), stored as SHA-256 hashes
- Token blacklist in Redis on logout — O(1) check on every request
- Brute-force protection: 10 failed logins → 15-min lockout
- Webhook SSRF protection: DNS-resolved IP range check at register + send time
- Webhook URLs must be HTTPS (validated at DTO layer)
- `userId` always derived from verified JWT — never from request body
- Rate limiting: global 100 req/min, stricter on auth endpoints

---

## Running Tests

```bash
npm test           # all tests
npm run test:cov   # coverage report
npm run test:cil   # CIL unit tests (40 tests, 90% threshold)
npm run typecheck  # TypeScript strict check
```

---

## Deploying to Railway / Render / Fly.io

1. Push repo to GitHub
2. Connect in your platform dashboard
3. Set all env vars from `.env.example`
4. Build command: `npm run build`
5. Start command: `npm run start:prod`

The app exits at startup if `DATABASE_URL`, `REDIS_URL`, or `JWT_SECRET` are missing.
