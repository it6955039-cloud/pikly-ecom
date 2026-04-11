# Pikly Store API v3 — Setup Guide

## Architecture

```
CLIENT
  └── NestJS REST API (port 3000)
        ├── Neon PostgreSQL  — all persistent data (store.* schema)
        │     ├── store.*    — users, products, orders, cart, coupons, wishlists, webhooks
        │     ├── catalog.*  — LTREE taxonomy, EAV attributes, accordion content
        │     ├── cil.*      — AI quality scores, attribute families
        │     └── search.*   — Algolia sync state
        ├── Redis (Upstash)  — JWT blacklist, brute-force counters, pub/sub cache invalidation
        ├── Algolia          — full-text search + faceted filtering
        └── Gemini Flash     — free AI for accordion content grouping (optional)
```

## Step-by-Step Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:
- `DATABASE_URL` — Neon pooler URL (port **6543**)
- `REDIS_URL` — Upstash Redis URL
- `JWT_SECRET` — 64+ character random string
- `JWT_REFRESH_SECRET` — different 64+ character random string

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Run database migrations

You need the **direct** Neon connection URL (port 5432) for `psql`:

```bash
# All schemas in one shot:
psql $DIRECT_NEON_URL < sql/000_full_schema.sql

# Or individually:
psql $DIRECT_NEON_URL < sql/001_schema_neon.sql   # LTREE taxonomy + catalog schema
psql $DIRECT_NEON_URL < sql/002_cil_schema.sql     # CIL AI tables
psql $DIRECT_NEON_URL < sql/003_app_schema.sql     # App tables (users, orders, cart…)
```

### 4. Seed data
```bash
npm run seed
```

### 5. (Optional) Sync Algolia search index
```bash
npm run sync-algolia
```

### 6. Start the server
```bash
npm run start:dev       # development with hot reload
npm run start:prod      # production (requires npm run build first)
```

API: `http://localhost:3000/api/v1`  
Swagger: `http://localhost:3000/api/v1/docs` (requires `SWAGGER_ENABLED=true` in `.env`)

---

## Admin Access

Register a user via `POST /api/v1/auth/register`, then promote to admin:

```bash
# Via psql
UPDATE store.users SET role = 'admin' WHERE email = 'you@example.com';

# Or via admin API (requires an existing admin token)
PATCH /api/v1/admin/users/:id/role  { "role": "admin" }
```

Then log in again to receive a fresh token with the updated role.

---

## CIL (Catalog Intelligence Layer)

After seeding, optionally run AI enrichment:

```bash
# Requires GEMINI_API_KEY in .env
curl -X POST /api/v1/admin/cil/families/generate     -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST /api/v1/admin/cil/jobs/accordion        -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST /api/v1/admin/cil/jobs/quality-scoring  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Tests

```bash
npm test            # all unit tests
npm run test:cov    # coverage report (CIL target: 90%)
npm run test:cil    # CIL unit tests only
npm run typecheck   # TypeScript strict check (no emit)
```

---

## Deployment (Railway / Render / Fly.io)

1. Push to GitHub
2. Connect repo in your platform dashboard
3. Set all environment variables from `.env.example`
4. Build command: `npm run build`
5. Start command: `npm run start:prod`

The app exits on startup if `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, or `JWT_REFRESH_SECRET` are missing.
