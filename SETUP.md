# Setup Guide

Complete walkthrough from zero to a running Pikly API. Estimated time: **30 minutes**.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| Python | ≥ 3.12 | [python.org](https://www.python.org/downloads) |
| psql | any | Bundled with [PostgreSQL](https://www.postgresql.org/download) |
| Git | any | [git-scm.com](https://git-scm.com) |

---

## Step 1 — Provision Cloud Services

All services below have permanent free tiers. No credit card required.

### PostgreSQL — Neon

1. Sign up at [neon.tech](https://neon.tech)
2. Create a project → name it `pikly`
3. Go to **Connection Details** → copy the **connection string**:
   ```
   postgresql://user:pass@ep-xxx-xxx.region.aws.neon.tech/neondb?sslmode=require
   ```
   Save this as `DATABASE_URL`.

### Redis — Upstash

1. Sign up at [upstash.com](https://upstash.com)
2. Create a **Redis** database → pick the region closest to you
3. Copy the **Redis URL** — use `rediss://` (double-s, TLS required):
   ```
   rediss://default:token@us1-xxx.upstash.io:6379
   ```
   Save this as `REDIS_URL`.

> **Without Redis:** The API starts and serves products normally. JWT blacklisting, brute-force protection, and cross-process cache invalidation are disabled. Suitable for development.

### Algolia — Search

1. Sign up at [algolia.com](https://algolia.com)
2. Create an application → name it `pikly`
3. Go to **Settings → API Keys**:
   - **Application ID** → `ALGOLIA_APP_ID`
   - **Admin API Key** → `ALGOLIA_WRITE_KEY`

> **Without Algolia:** The API falls back to in-memory Fuse.js search. Products load and list correctly; advanced faceting is unavailable.

### Gemini AI — CIL Enrichment (optional)

1. Go to [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Sign in with Google → **Create API key**
3. Save as `GEMINI_API_KEY`

> **Without Gemini:** CIL uses rule-based accordion grouping (covers ~70% of products automatically). Quality scoring works fully without it.

---

## Step 2 — Apply the Database Schema

Run the single schema file against your Neon database. **Run this exactly once** on a fresh database.

### Option A — psql (recommended)

```bash
export DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"
psql "$DATABASE_URL" -f api/sql/000_complete_schema.sql
```

You should see at the end:
```
NOTICE:  Schema v5.0.0 verified — all tables, triggers, LTREE indexes present.
```

### Option B — Neon SQL Editor

1. Open your project in the Neon dashboard
2. Go to the **SQL Editor** tab
3. Open `api/sql/000_complete_schema.sql`, paste the entire contents, and run

---

## Step 3 — Configure Environment

```bash
cp .env.example api/.env
```

Edit `api/.env` and fill in the following (minimum required):

```env
DATABASE_URL=postgresql://...    # from Step 1 — Neon
JWT_SECRET=...                   # generate: openssl rand -hex 32
```

Strongly recommended:

```env
REDIS_URL=rediss://...           # from Step 1 — Upstash
JWT_REFRESH_SECRET=...           # generate: openssl rand -hex 32
ALGOLIA_APP_ID=...
ALGOLIA_WRITE_KEY=...
ALGOLIA_INDEX=products
SWAGGER_ENABLED=true             # enables /api/docs in development
```

Optional:

```env
GEMINI_API_KEY=...               # enables AI accordion + facet generation in CIL
CLOUDINARY_CLOUD_NAME=...        # enables image upload
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

---

## Step 4 — Place Data File

Copy your `products_cleaned.jsonl` into the `api/data/` directory:

```
api/data/products_cleaned.jsonl     ← place it here
```

**Optional — run the Discovery Engine first** (adds AI-powered `bought_together` and `related_products`):

```bash
cd pipeline
pip install -r requirements.txt

python hybrid_discovery_engine.py \
  --input ../api/data/products_cleaned.jsonl \
  --output ../api/data/products_discovery_enhanced.jsonl
```

The seeder automatically prefers `products_discovery_enhanced.jsonl` over `products_cleaned.jsonl` if both exist.

---

## Step 5 — Install Dependencies

```bash
cd api
npm install
```

---

## Step 6 — Seed the Database

### Option A — TypeScript seeder (simpler)

```bash
cd api

# Test with 50 products first
npx ts-node scripts/seed-pg.ts --limit 50

# Verify it worked
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM store.products WHERE is_active=true"

# Full seed (all 4,139 products)
npx ts-node scripts/seed-pg.ts
```

### Option B — Python ETL (faster, streaming, progress bar)

```bash
cd pipeline
pip install -r requirements.txt

python ingest.py ../api/data/products_cleaned.jsonl --batch 300
```

The Python ETL streams the file line-by-line and never loads it all into RAM.

---

## Step 7 — Seed Categories

```bash
cd api
npx ts-node scripts/seed-categories-pg.ts
```

This populates `store.categories` with departments and subcategories.

---

## Step 8 — Sync to Algolia

```bash
cd api
npx ts-node scripts/sync-algolia-pg.ts
```

This configures the Algolia index and pushes all active products.

---

## Step 9 — Run the API

```bash
cd api
npm run start:dev
```

Verify everything is working:

```bash
# Liveness check
curl http://localhost:3000/health

# Products list
curl http://localhost:3000/api/products | head -200

# Departments
curl http://localhost:3000/api/departments

# Swagger docs (if SWAGGER_ENABLED=true)
open http://localhost:3000/api/docs
```

---

## Step 10 — Run CIL Enrichment (Optional)

CIL adds AI-powered accordion grouping, quality scores, and per-category facet configs. Run after seeding.

```bash
# Get an admin JWT token
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"yourpassword"}' \
  | python3 -m json.tool

# Set the token
TOKEN="eyJhbGciOiJIUzI1NiIs..."

# 1. Generate attribute families (~5 seconds)
curl -X POST http://localhost:3000/api/admin/cil/families/generate \
  -H "Authorization: Bearer $TOKEN"

# 2. Generate accordion content (5-15 min for 4k products, restartable)
curl -X POST http://localhost:3000/api/admin/cil/jobs/accordion \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 100}'

# 3. Quality scoring (~2-3 min for 4k products, restartable)
curl -X POST http://localhost:3000/api/admin/cil/jobs/quality-scoring \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 200}'

# Check health and progress
curl http://localhost:3000/api/admin/cil/health \
  -H "Authorization: Bearer $TOKEN"
```

See **[CIL.md](CIL.md)** for a complete guide.

---

## Troubleshooting

**`DATABASE_URL not set`**
Ensure `api/.env` exists (not just `.env.example`) and that you're running commands from inside the `api/` directory.

**Products not appearing after seed**
The API loads products into memory on startup. After seeding, restart the server (`Ctrl+C` → `npm run start:dev`).

**`slug already exists` error during seed**
Use `--clear` to truncate first: `npx ts-node scripts/seed-pg.ts --clear`

**Algolia returning zero results**
Run `npx ts-node scripts/sync-algolia-pg.ts` and verify `ALGOLIA_APP_ID` and `ALGOLIA_WRITE_KEY` are correct. Check the Algolia dashboard for the index.

**Redis connection error on Upstash**
Upstash requires TLS. Use `rediss://` (double-s), not `redis://`.

**CIL `families/generate` returns `created: 0`**
Products must be seeded before running CIL. The job reads from `store.products`.

**`test-db.js` for quick connectivity check**
```bash
node api/test-db.js
```
