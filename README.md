# Pikly — Enterprise eCommerce API

**v5.0.0** · NestJS · PostgreSQL (Neon) · Algolia · Redis · Python ETL · Go Cache-Proxy · C++ Ranker

---

## Stack

| Layer | Technology | Purpose |
|---|---|---|
| **API** | NestJS 10 + TypeScript 5 | REST endpoints, business logic |
| **Database** | Neon PostgreSQL (LTREE + GIN) | Products, orders, users, catalog |
| **Search** | Algolia | Full-text search, faceted filtering |
| **Cache / Pub-Sub** | Redis (Upstash) | JWT blacklist, rate-limiting, invalidation |
| **ETL Pipeline** | Python 3.12 + asyncpg + Pydantic v2 | Ingest `products_cleaned.jsonl` → PostgreSQL |
| **Discovery Engine** | Python + sentence-transformers + BM25 | AI-powered related products + bought-together |
| **Cache Proxy** | Go (Gin) | Redis-backed reverse proxy, circuit breaker, Prometheus |
| **Ranking Addon** | C++ N-API + libuv | Sub-millisecond product ranking in a worker thread |
| **AI Enrichment** | Google Gemini 1.5 Flash (free) | Accordion grouping, per-category facet config |
| **Images** | Cloudinary | Product image upload and CDN |

---

## Repository Layout

```
pikly/
├── api/                        NestJS REST API
│   ├── src/
│   │   ├── products/           Products CRUD, search, reviews
│   │   ├── departments/        ← NEW: department-level catalog aggregation
│   │   ├── categories/         Category tree (store.categories)
│   │   ├── catalog-intelligence/  CIL — quality scoring, accordion, facets
│   │   ├── auth/               JWT auth, refresh tokens, email verification
│   │   ├── cart/               Session + user cart with coupon support
│   │   ├── orders/             Order lifecycle management
│   │   ├── homepage/           Curated homepage sections
│   │   ├── admin/              Admin controllers (products, orders, users…)
│   │   └── …
│   ├── scripts/
│   │   ├── seed-pg.ts          Seed store.products from JSONL
│   │   ├── seed-categories-pg.ts  Seed store.categories
│   │   └── sync-algolia-pg.ts  Push store.products → Algolia index
│   └── sql/
│       └── 000_complete_schema.sql  ← Single schema file (run this once)
│
├── pipeline/                   Python ETL
│   ├── hybrid_discovery_engine.py  BM25 + semantic recommendations
│   ├── ingest.py               Async streaming JSONL → PostgreSQL
│   ├── validate.py             Pydantic v2 schemas
│   └── transform.py            Pure transformation functions
│
├── services/
│   └── cache-proxy/            Go reverse proxy
│       ├── cmd/server/main.go  Gin server, graceful shutdown
│       └── internal/           cache, middleware, proxy packages
│
├── native/
│   └── ranker/                 C++ N-API addon
│       ├── src/ranker.cc       Composite scoring engine
│       └── index.ts            TypeScript wrapper + JS fallback
│
├── .env.example                Template — copy to api/.env
├── SETUP.md                    ← Start here
├── DATABASE.md                 Schema design and SQL reference
├── API.md                      Full API endpoint reference
├── CIL.md                      Catalog Intelligence Layer guide
└── DEPLOY.md                   Free cloud deployment guide
```

---

## Quick Start

```bash
# 1. Apply database schema (Neon SQL editor or psql)
psql $DATABASE_URL -f api/sql/000_complete_schema.sql

# 2. Configure environment
cp .env.example api/.env
# Edit api/.env — fill in DATABASE_URL, REDIS_URL, JWT_SECRET etc.

# 3. Place data file
cp /path/to/products_cleaned.jsonl api/data/

# 4. Install & seed
cd api && npm install
npx ts-node scripts/seed-pg.ts
npx ts-node scripts/sync-algolia-pg.ts

# 5. Run
npm run start:dev
# → API:    http://localhost:3000/api/products
# → Docs:   http://localhost:3000/api/docs  (set SWAGGER_ENABLED=true)
# → Health: http://localhost:3000/health
```

Full setup → **[SETUP.md](SETUP.md)**
Deployment → **[DEPLOY.md](DEPLOY.md)**

---

## API Base URL

All endpoints are prefixed with `/api`. Health check at `/health` (no prefix).

```
http://localhost:3000/api/products
http://localhost:3000/api/departments
http://localhost:3000/api/auth/login
http://localhost:3000/api/admin/products
http://localhost:3000/api/admin/cil/health
http://localhost:3000/health
http://localhost:3000/api/docs          ← Swagger (SWAGGER_ENABLED=true)
```

See **[API.md](API.md)** for the full endpoint reference.

---

## Database Schema (3 PostgreSQL schemas)

| Schema | Purpose |
|---|---|
| `store.*` | Application data — products, users, orders, cart, categories |
| `catalog.*` | CIL output — LTREE-indexed product mirror, EAV attributes, accordion content |
| `cil.*` | Intelligence metadata — quality scores, attribute families, AI cache, jobs |

One SQL file to set everything up: `api/sql/000_complete_schema.sql`

See **[DATABASE.md](DATABASE.md)** for schema documentation.

---

## License

Proprietary — all rights reserved.
