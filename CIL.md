# Catalog Intelligence Layer (CIL)

CIL is an AI-powered enrichment system that runs **on top of** the seeded product data. It is fully optional — the API serves products correctly without it.

---

## What CIL Does

| Job | Input | Output | Benefit |
|---|---|---|---|
| `families/generate` | `store.products` taxonomy | `cil.attribute_families`, `cil.facet_configs` | Per-category Algolia facet configs |
| `jobs/accordion` | `store.products.product_details` | `catalog.product_accordion`, `catalog.product_attributes` | Better-organised spec sections |
| `jobs/quality-scoring` | `store.products` + family schemas | `cil.product_quality` | Quality scores for admin dashboard |

---

## Prerequisites

1. Products must be seeded (`store.products` must have rows)
2. An admin JWT token is required for all CIL endpoints
3. `GEMINI_API_KEY` set in `.env` — optional but strongly recommended. Without it, the accordion job uses rule-based grouping only (covers ~70% of products; Gemini handles the remaining ~30% that are ambiguous)

---

## Architecture

```
store.products (source of truth)
       │
       ├──► cil.attribute_families     ← families/generate
       │         (one per dept/subcat)
       │
       ├──► catalog.product_accordion  ← jobs/accordion
       │         (AI-grouped specs)
       │
       ├──► catalog.product_attributes ← jobs/accordion
       │         (partitioned EAV, LTREE-linked)
       │
       └──► cil.product_quality        ← jobs/quality-scoring
                 (0-100 score per product)
```

`catalog.products` is a LTREE-indexed mirror of `store.products` synced by a DB trigger. CIL uses it for `<@` ancestor queries.

---

## Running CIL Jobs

### Step 1 — Get an admin JWT

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "yourpassword"}'
```

Copy the `accessToken` from the response.

```bash
TOKEN="eyJhbGciOiJIUzI1NiIs..."
```

### Step 2 — Generate Attribute Families

Reads `store.products` taxonomy columns, derives LTREE paths, and creates one `cil.attribute_families` entry per department and per subcategory with ≥ 5 products. Uses Gemini to generate per-category facet configurations.

**Run time:** ~5 seconds

```bash
curl -X POST http://localhost:3000/api/admin/cil/families/generate \
  -H "Authorization: Bearer $TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "created": 14,
    "updated": 0,
    "skipped": 0,
    "names": ["Beauty and Personal Care", "Electronics", "..."]
  }
}
```

**Dry run** (no writes):
```bash
curl "http://localhost:3000/api/admin/cil/families/generate?dryRun=true" \
  -X POST -H "Authorization: Bearer $TOKEN"
```

### Step 3 — Generate Accordion Content

Processes every product in `store.products` that doesn't yet have a `catalog.product_accordion` entry. For each product:

1. Extracts `product_details` JSONB column
2. Tries rule-based grouping (14 keyword rules → groups like "Connectivity & Compatibility", "Power & Battery", "Dimensions & Weight", etc.)
3. If rule-based covers < 65% of attributes → calls Gemini for AI grouping
4. Caches the Gemini response in `cil.ai_cache` (30-day TTL) by content hash
5. Writes to `catalog.product_accordion` and `catalog.product_attributes`

**Run time:** 5–15 minutes for 4,139 products (depends on Gemini quota)

**Cursor-based — fully restartable.** If interrupted, resume from the last processed ASIN:

```bash
# Start
curl -X POST http://localhost:3000/api/admin/cil/jobs/accordion \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 100}'

# Resume from a specific ASIN
curl -X POST http://localhost:3000/api/admin/cil/jobs/accordion \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 100, "resumeFromAsin": "B07XYZ123"}'
```

### Step 4 — Quality Scoring

Scores every active product across 7 dimensions:

| Dimension | Weight | What it checks |
|---|---|---|
| Title | 25% | Length (30–250 chars), no ALL CAPS, brand mentioned |
| Images | 20% | Thumbnail present, ≥ 6 images |
| Description | 15% | `about_item` has ≥ 3 bullets |
| Attributes | 20% | Coverage vs. family schema (required attrs present) |
| Variants | 10% | Colors and/or sizes defined |
| Reviews | 5% | Count ≥ 10, rating ≥ 3.5 |
| Taxonomy | 5% | Has both dept + subcategory |

**Run time:** ~2–3 minutes for 4,139 products. No Gemini calls needed.

```bash
curl -X POST http://localhost:3000/api/admin/cil/jobs/quality-scoring \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 200}'
```

---

## Monitoring

### Health check

```bash
curl http://localhost:3000/api/admin/cil/health \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "neonHealthy": true,
    "stats": {
      "product_count": 4139,
      "family_count": 28,
      "accordion_count": 3950,
      "scored_count": 4139,
      "avg_quality": 72.4,
      "running_jobs": 0
    }
  }
}
```

### Job history

```bash
curl "http://localhost:3000/api/admin/cil/jobs?limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

### Quality summary

```bash
curl http://localhost:3000/api/admin/cil/quality/summary \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "total_scored": 4139,
    "avg_score": 72.4,
    "high_quality": 1820,
    "medium_quality": 1953,
    "low_quality": 366,
    "pending_rescore": 0
  }
}
```

### Worst-quality products (for remediation)

```bash
# Products with score < 50
curl "http://localhost:3000/api/admin/cil/quality?maxScore=50&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Preview accordion for a single product (without persisting)

```bash
curl -X POST http://localhost:3000/api/admin/cil/accordion/preview \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"asin": "B001A2VBUU"}'
```

---

## AI Cache

The AI cache prevents redundant Gemini API calls. Products with identical `product_details` share a cached response.

```bash
# View cache statistics
curl http://localhost:3000/api/admin/cil/cache/stats \
  -H "Authorization: Bearer $TOKEN"
```

Cache entries expire after 30 days. To invalidate the cache and force regeneration, bump `AI_PROMPT_VERSION` in `src/catalog-intelligence/types/cil.types.ts` from `'v3'` to `'v4'`.

---

## Family Schema Refresh

After running the accordion job, attribute schemas can be refined with real fill-rate data:

```bash
curl -X POST http://localhost:3000/api/admin/cil/families/refresh-schema \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taxonomyPath": "beauty_and_personal_care.toners_astringents"}'
```

This analyses `store.products.attr_values` for all products in the LTREE subtree and marks attributes present in ≥ 80% of products as `required: true` in the family schema.

---

## LTREE Taxonomy Paths

CIL uses LTREE paths to identify taxonomy nodes. The path format mirrors what the `store.products` trigger computes:

```
beauty_and_personal_care              ← depth 1 (department)
beauty_and_personal_care.toners_astringents  ← depth 2 (subcategory)
electronics.headphones_audio
tools_home_improvement.power_tools
```

Pass these paths to `/families/refresh-schema` and `/facets/:path`.

---

## Recommended Run Order

```
seed-pg.ts (or ingest.py)
     ↓
families/generate          ← ~5 sec
     ↓
jobs/accordion             ← 5-15 min, restartable
     ↓
families/refresh-schema    ← optional, one per dept (~30 sec)
     ↓
jobs/quality-scoring       ← 2-3 min, restartable
```
