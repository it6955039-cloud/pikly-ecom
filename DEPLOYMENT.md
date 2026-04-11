# DEPLOYMENT.md — Deploy Pikly for Free (No Local Hosting, No Credit Card)

This guide gets your full stack live using **100% free cloud services**.
You never need to run a server on your own machine.

---

## Free Services Used

| Service | What it hosts | Free limit | Credit card? |
|---|---|---|---|
| **Neon** | PostgreSQL database | 512 MB, always free | ❌ No |
| **Upstash** | Redis cache | 10,000 req/day, always free | ❌ No |
| **Railway** | NestJS API + Go proxy | $5 credit/month (enough for small apps) | ❌ No |
| **Fly.io** | Go cache-proxy alternative | 3 VMs free forever | ❌ No |
| **GitHub** | Code repo + CI/CD (Actions) | Free for public repos | ❌ No |
| **Algolia** | Search | 10,000 searches/month | ❌ No |

**Total monthly cost: $0.00**

---

## Step 1 — Set Up Free PostgreSQL (Neon)

1. Go to [neon.tech](https://neon.tech) → **Sign up free**
2. Create a project → name it `pikly`
3. Copy the **connection string** — looks like:
   ```
   postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
   ```
4. Apply the database schema:
   - Open the **SQL Editor** tab in Neon dashboard
   - Paste and run each file in order:
     ```
     api/sql/001_schema_neon.sql
     api/sql/002_cil_schema.sql
     api/sql/003_app_schema.sql
     api/sql/004_new_dataset_columns.sql
     ```
   - Or run them all at once by pasting the content of `api/sql/000_full_schema.sql`

---

## Step 2 — Set Up Free Redis (Upstash)

1. Go to [upstash.com](https://upstash.com) → **Sign up free**
2. Create a Redis database → region: pick closest to you
3. Copy the **Redis URL** — looks like:
   ```
   redis://default:xxxxx@us1-xxxx.upstash.io:6379
   ```
   And the **host:port** separately:
   ```
   us1-xxxx.upstash.io:6379
   ```

---

## Step 3 — Push Code to GitHub

```bash
# On your computer (one-time setup):
git init
git add .
git commit -m "Initial commit"
git branch -M main

# Create a new repo at github.com then:
git remote add origin https://github.com/YOUR_USERNAME/pikly-enterprise.git
git push -u origin main
```

---

## Step 4 — Deploy NestJS API to Railway

**Railway gives $5 free credit/month — enough for 24/7 operation on a small app.**

1. Go to [railway.app](https://railway.app) → **Sign up with GitHub** (no credit card)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `pikly-enterprise` repo
4. Set **Root Directory** to `api`
5. Railway auto-detects Node.js from `package.json`
6. Set these **environment variables** in Railway dashboard:

   ```
   NODE_ENV          = production
   DATABASE_URL      = (paste your Neon URL)
   REDIS_URL         = (paste your Upstash Redis URL)
   JWT_SECRET        = (generate: openssl rand -hex 32)
   ALGOLIA_APP_ID    = (from algolia.com dashboard)
   ALGOLIA_WRITE_KEY = (from algolia.com dashboard)
   ALGOLIA_INDEX     = products
   ```

7. Railway builds and deploys automatically. Your API will be at:
   ```
   https://pikly-api-xxxx.railway.app
   ```

---

## Step 5 — Deploy Go Cache-Proxy to Fly.io

**Fly.io free tier: 3 machines, 256MB RAM each — runs 24/7 forever.**

1. Install the Fly CLI on your computer:
   ```bash
   # Windows (PowerShell):
   iwr https://fly.io/install.ps1 -useb | iex

   # Mac/Linux:
   curl -L https://fly.io/install.sh | sh
   ```

2. Sign up and deploy:
   ```bash
   cd services/cache-proxy

   fly auth signup          # no credit card needed for free tier
   fly launch               # auto-detects Dockerfile, creates app
   fly secrets set \
     UPSTREAM_URL=https://pikly-api-xxxx.railway.app \
     REDIS_ADDR=us1-xxxx.upstash.io:6379

   fly deploy
   ```

3. Your proxy will be at:
   ```
   https://pikly-cache-proxy.fly.dev
   ```

> **Tip:** If you don't want the Go proxy yet, just use the Railway API URL directly.
> The proxy adds caching but the API works fine without it.

---

## Step 6 — Seed the Database

You seed from your **local computer** (one-time only — no server needed):

### Option A: Python ETL (recommended for large datasets)

```bash
# Install Python deps (one-time):
cd pipeline
pip install -r requirements.txt

# Run the seeder (streams the JSONL file — never loads it all into RAM):
python ingest.py /path/to/products_cleaned.jsonl --batch 300
```

Set `DATABASE_URL` first:
```bash
# Windows:
set DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

# Mac/Linux:
export DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

### Option B: TypeScript seeder

```bash
cd api
npm install

# Seed categories first:
npx ts-node scripts/seed-categories-pg.ts

# Then products:
npx ts-node scripts/seed-pg.ts
```

### Option C: GitHub Actions (no local Python needed)

1. Go to your GitHub repo → **Settings** → **Secrets** → **Actions**
2. Add secret: `DATABASE_URL` = your Neon URL
3. Go to **Actions** tab → select **CI / CD** workflow → **Run workflow**
4. Check **"Run Python ETL pipeline?"** → click **Run workflow**

---

## Step 7 — Sync Algolia

```bash
cd api
npx ts-node scripts/sync-algolia-pg.ts
```

Or trigger via GitHub Actions (same workflow, step runs automatically on merge to main).

---

## Step 8 — Set GitHub Actions Secrets (for auto-deploy)

Go to: `github.com/YOUR_USERNAME/pikly-enterprise` → **Settings** → **Secrets and variables** → **Actions**

Add these secrets:

| Secret | Value |
|---|---|
| `RAILWAY_TOKEN` | From railway.app → Settings → Tokens |
| `FLY_API_TOKEN` | Run `fly auth token` on your computer |
| `DATABASE_URL` | Your Neon connection string |
| `ALGOLIA_APP_ID` | From algolia.com |
| `ALGOLIA_WRITE_KEY` | From algolia.com |
| `ALGOLIA_INDEX` | `products` |

After this, every `git push` to `main` auto-deploys everything.

---

## Architecture After Deployment

```
Your Users
    │
    ▼
https://pikly-cache-proxy.fly.dev   ← Go proxy (Fly.io — free)
    │   Redis cache (Upstash — free)
    │   Cache miss only ↓
    ▼
https://pikly-api-xxxx.railway.app  ← NestJS API (Railway — free)
    │
    ├── PostgreSQL (Neon — free)
    ├── Redis (Upstash — free)
    └── Algolia (free tier)

Your Computer (one-time only)
    └── python ingest.py → Neon PostgreSQL
        npx ts-node sync-algolia-pg.ts → Algolia
```

---

## Costs at Scale

When you outgrow the free tiers:

| Service | When to upgrade | Cost |
|---|---|---|
| Railway | > $5 free credit used | $5/month Hobby plan |
| Neon | > 512 MB database | $19/month Pro |
| Upstash | > 10K Redis req/day | $0.20 per 100K req |
| Algolia | > 10K searches/month | $29/month |
| Fly.io | > 3 VMs | ~$2/month/VM |

---

## Troubleshooting

**API not connecting to database:**
- Check `DATABASE_URL` has `?sslmode=require` at the end
- Neon requires SSL — never use `sslmode=disable` with Neon

**Redis connection errors:**
- Upstash free tier uses TLS — use `rediss://` (double-s) URL for TLS connections
- In `REDIS_URL` env var use: `rediss://default:xxx@us1-xxx.upstash.io:6379`

**Railway build failing:**
- Check that `api/package.json` has a `build` script: `"build": "nest build"`
- Make sure `api/nest-cli.json` exists

**Products not showing after seed:**
- The API hot-caches products in memory on startup
- After seeding, trigger a restart: in Railway dashboard → **Restart**
- Or call: `POST /api/admin/products/invalidate` (admin JWT required)
