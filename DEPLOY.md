# Deployment Guide

Deploy the full Pikly stack for **$0/month** using free cloud services. No local server required.

---

## Free Services Summary

| Service | Hosts | Free Tier | Credit Card? |
|---|---|---|---|
| [Neon](https://neon.tech) | PostgreSQL | 512 MB storage, always free | No |
| [Upstash](https://upstash.com) | Redis | 10,000 req/day, always free | No |
| [Railway](https://railway.app) | NestJS API | $5 credit/month | No |
| [Fly.io](https://fly.io) | Go cache-proxy | 3 VMs always free | No |
| [GitHub](https://github.com) | Code + CI/CD | Free for public repos | No |
| [Algolia](https://algolia.com) | Search | 10,000 searches/month | No |
| [Gemini](https://aistudio.google.com) | CIL AI | Free tier | No |

---

## Step 1 — Push Code to GitHub

```bash
git init
git add .
git commit -m "feat: initial pikly v5.0.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pikly.git
git push -u origin main
```

---

## Step 2 — Apply Database Schema (Neon)

From your local machine (one time only):

```bash
export DATABASE_URL="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"
psql "$DATABASE_URL" -f api/sql/000_complete_schema.sql
```

---

## Step 3 — Seed Products (from your machine)

```bash
cd api
npm install

# Option A — TypeScript seeder
npx ts-node scripts/seed-pg.ts

# Option B — Python ETL (streaming, progress bar)
cd ../pipeline
pip install -r requirements.txt
python ingest.py ../api/data/products_cleaned.jsonl --batch 300
```

Seed your categories and sync Algolia:

```bash
cd api
npx ts-node scripts/seed-categories-pg.ts
npx ts-node scripts/sync-algolia-pg.ts
```

---

## Step 4 — Deploy NestJS API to Railway

Railway auto-deploys from GitHub on every push to `main`.

1. Go to [railway.app](https://railway.app) → Sign up with GitHub (no credit card)
2. **New Project → Deploy from GitHub repo** → select your repository
3. Set **Root Directory** to `api`
4. Set environment variables in the Railway dashboard:

   ```
   NODE_ENV          = production
   DATABASE_URL      = (your Neon connection string)
   REDIS_URL         = (your Upstash Redis URL — rediss://)
   JWT_SECRET        = (openssl rand -hex 32)
   JWT_REFRESH_SECRET= (openssl rand -hex 32)
   ALGOLIA_APP_ID    = (from Algolia dashboard)
   ALGOLIA_WRITE_KEY = (from Algolia dashboard)
   ALGOLIA_INDEX     = products
   GEMINI_API_KEY    = (from Google AI Studio)
   SWAGGER_ENABLED   = false
   ```

5. Railway detects Node.js from `package.json` and builds automatically.

Your API will be live at:
```
https://pikly-api-xxxx.railway.app
```

---

## Step 5 — Deploy Go Cache-Proxy to Fly.io

Fly.io provides 3 free shared VMs that run 24/7 permanently.

### Install Fly CLI

```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

### Deploy

```bash
cd services/cache-proxy

fly auth signup     # no credit card needed for free tier
fly launch          # auto-detects Dockerfile, prompts for app name

fly secrets set \
  UPSTREAM_URL=https://pikly-api-xxxx.railway.app \
  REDIS_ADDR=us1-xxxx.upstash.io:6379

fly deploy
```

Your proxy will be at:
```
https://pikly-cache-proxy.fly.dev
```

> **Note:** The Go proxy is optional. The Railway API URL works directly without it. The proxy adds Redis caching (15 min TTL for product detail, 2 min for search results) and a circuit breaker.

---

## Step 6 — Set Up GitHub Actions (auto-deploy)

Go to your GitHub repo → **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `RAILWAY_TOKEN` | From railway.app → Settings → Tokens |
| `FLY_API_TOKEN` | Run `fly auth token` locally |
| `DATABASE_URL` | Your Neon connection string |
| `ALGOLIA_APP_ID` | From Algolia |
| `ALGOLIA_WRITE_KEY` | From Algolia |
| `ALGOLIA_INDEX` | `products` |

After this, every `git push` to `main` automatically:
- Runs TypeScript type-check + tests
- Deploys the API to Railway
- Deploys the Go proxy to Fly.io

---

## Architecture After Deployment

```
Users
  │
  ▼
https://pikly-cache-proxy.fly.dev    ← Go proxy (Fly.io, always free)
  │    Redis cache (Upstash)
  │    Cache miss ↓
  ▼
https://pikly-api-xxxx.railway.app   ← NestJS API (Railway, $5 credit/month)
  │
  ├── Neon PostgreSQL (always free)
  ├── Upstash Redis   (always free)
  └── Algolia         (free tier)

Your laptop (one-time, then automated via GitHub Actions)
  └── npx ts-node seed-pg.ts → Neon
  └── npx ts-node sync-algolia-pg.ts → Algolia
```

---

## Environment Variables Reference

See `.env.example` in the project root for the complete list with descriptions.

**Minimum required to start:**
```
DATABASE_URL
JWT_SECRET
```

**Strongly recommended:**
```
REDIS_URL
JWT_REFRESH_SECRET
ALGOLIA_APP_ID
ALGOLIA_WRITE_KEY
```

**Optional features:**
```
GEMINI_API_KEY        CIL AI accordion + facets
CLOUDINARY_*          Image upload
MAIL_*                Email verification, password reset
SWAGGER_ENABLED=true  Swagger UI (dev only)
ALLOWED_ORIGINS       CORS origins (comma-separated)
```

---

## Cost Projections

| Traffic level | Monthly cost |
|---|---|
| Development / small site (< 10K req/month) | **$0** |
| Medium site (< 50K req/month) | **$0–$5** (Railway may use credit) |
| Growing site (100K+ req/month) | ~$20–40 (Neon Pro + Railway Hobby) |
