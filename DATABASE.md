# Database Reference

Pikly uses **Neon PostgreSQL** with three schemas and proper LTREE taxonomy indexing.

---

## SQL Files — What to Run

There is exactly **one file to run** for a fresh setup:

```
api/sql/000_complete_schema.sql
```

```bash
psql "$DATABASE_URL" -f api/sql/000_complete_schema.sql
```

The file is **idempotent** — safe to re-run. It uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `CREATE OR REPLACE FUNCTION` throughout.

The legacy files `001_schema_neon.sql`, `002_cil_schema.sql`, `003_app_schema.sql`, `004_new_dataset_columns.sql`, and `005_pikly_source_migration.sql` are **superseded** by `000_complete_schema.sql` and do not need to be run on a fresh database.

---

## Schema Overview

```
store.*     Application layer — NestJS reads and writes here
catalog.*   CIL output layer — LTREE-indexed, synced by trigger
cil.*       Intelligence metadata — quality scores, AI cache, jobs
```

### PostgreSQL Extensions

All enabled automatically by the schema file:

| Extension | Purpose |
|---|---|
| `ltree` | Hierarchical taxonomy paths with `<@` ancestor queries |
| `pg_trgm` | Trigram similarity for full-text search on title/brand |
| `uuid-ossp` | UUID generation (`uuid_generate_v4()`) |
| `btree_gin` | GIN indexes on scalar columns |

---

## store Schema

### store.products

Primary product table. The NestJS API reads from here exclusively. The Python ETL seeder writes here.

**Key columns:**

| Column | Type | Description |
|---|---|---|
| `asin` | `TEXT UNIQUE` | Amazon Standard Identification Number — primary business key |
| `slug` | `TEXT UNIQUE` | URL-safe identifier derived from title + ASIN |
| `taxonomy_dept` | `TEXT` | Department from `_taxonomy.department` in JSONL |
| `taxonomy_subcat` | `TEXT` | Subcategory from `_taxonomy.subcategory` in JSONL |
| `taxonomy_path` | `LTREE` | Auto-computed by trigger: `dept_slug.subcat_slug` |
| `product_results` | `JSONB` | Full scraper payload from `data.product_results` |
| `product_details` | `JSONB` | Product specifications from `data.product_details` |
| `reviews_info` | `JSONB` | All reviews from `data.reviews_information` |
| `accordion_content` | `JSONB` | Grouped specification sections (from seeder or CIL) |
| `bought_together` | `JSONB` | Frequently bought with (from Discovery Engine) |
| `related_products` | `JSONB` | Similar products (from Discovery Engine) |
| `enrichment_source_data` | `JSONB` | Pikly-specific enrichment: high-res images, reviews with media |
| `flags` | `JSONB` | All boolean flags from `_flags` in JSONL |
| `thumbnails` | `TEXT[]` | Image URLs array |
| `colors` | `TEXT[]` | Extracted from product variants — used in Algolia faceting |
| `sizes` | `TEXT[]` | Extracted from product variants — used in Algolia faceting |
| `attr_values` | `TEXT[]` | Attribute key:value pairs (`bluetooth_version:5.3`) for Algolia |

**LTREE trigger:** Every INSERT or UPDATE on `taxonomy_dept`/`taxonomy_subcat` auto-computes `taxonomy_path`. No manual action needed.

```sql
-- Example: "Beauty and Personal Care" + "Toners & Astringents"
-- taxonomy_path = beauty_and_personal_care.toners_astringents
```

**Hot-path indexes:**
- GIST on `taxonomy_path` — enables `<@` ancestor queries from CIL
- GIN on `product_results`, `enrichment_source_data` — JSONB containment queries
- GIN on `colors`, `sizes`, `attr_values` — array containment
- GIN on `title` with `gin_trgm_ops` — fuzzy text search
- Composite `(taxonomy_path, is_active, price, avg_rating DESC)` — product list queries

---

### store.categories

Category tree for navigation. Populated by `seed-categories-pg.ts`.

```sql
-- Level 0: department (Electronics, Beauty, etc.)
-- Level 1: subcategory (Headphones, Skin Care, etc.)
SELECT id, name, level, parent_id, product_count
FROM store.categories
WHERE level = 0 AND is_active = true
ORDER BY sort_order;
```

---

### Other store tables

| Table | Purpose |
|---|---|
| `store.users` | User accounts, addresses, loyalty points |
| `store.refresh_tokens` | JWT refresh token store |
| `store.carts` | Session-based shopping carts with coupon support |
| `store.orders` | Order lifecycle (pending → delivered) |
| `store.coupons` | Discount codes (percentage or fixed amount) |
| `store.banners` | Homepage banner configuration |
| `store.wishlists` | User wishlist (asin-keyed) |
| `store.recently_viewed` | Per-user recently viewed products |
| `store.product_reviews` | User-submitted reviews |
| `store.compare_lists` | Session-based product comparison |
| `store.webhooks` | Outbound webhook registrations |

---

## catalog Schema

### catalog.products

LTREE-indexed mirror of `store.products`. Synced automatically by the `trg_sync_to_catalog` trigger on every INSERT/UPDATE/DELETE to `store.products`.

**Never write to this table directly.** It exists so CIL can use proper `<@` ancestor queries:

```sql
-- Find all products under "Electronics" (any depth)
SELECT asin, title FROM catalog.products
WHERE taxonomy_path <@ 'electronics'::ltree
  AND is_active = true;

-- Find all products in a specific subcategory
SELECT asin FROM catalog.products
WHERE taxonomy_path = 'electronics.headphones'::ltree;
```

### catalog.product_accordion

AI-generated accordion sections per product. Written by the CIL `accordion_generation` job.

```sql
SELECT asin, content FROM catalog.product_accordion
WHERE asin = 'B001A2VBUU';
-- content: [{group, icon, attributes:[{key,label,value}]}]
```

### catalog.product_attributes

Partitioned EAV (Entity-Attribute-Value) table. Written by the CIL accordion job alongside `catalog.product_accordion`. Partitioned by `taxonomy_depth` (1–6) for efficient subtree queries.

```sql
-- Find all products with bluetooth_version = 5.3 under Electronics
SELECT DISTINCT pa.asin
FROM catalog.product_attributes pa
JOIN catalog.products cp ON cp.asin = pa.asin
WHERE pa.attr_key = 'bluetooth_version'
  AND pa.attr_value = '5.3'
  AND cp.taxonomy_path <@ 'electronics'::ltree;
```

---

## cil Schema

### cil.attribute_families

One row per taxonomy node (depth 1 = department, depth 2 = subcategory). Contains the attribute schema and Algolia facet configuration for that category. Populated by `POST /api/admin/cil/families/generate`.

```sql
SELECT name, taxonomy_path, schema_coverage, last_ai_review
FROM cil.attribute_families
WHERE is_active = true
ORDER BY taxonomy_depth, name;
```

### cil.product_quality

Per-product quality scores across 7 dimensions. Populated by `POST /api/admin/cil/jobs/quality-scoring`.

```sql
-- Find the 20 worst-quality products
SELECT asin, quality_score, issues
FROM cil.product_quality
ORDER BY quality_score ASC
LIMIT 20;
```

### cil.ai_cache

Gemini API response cache. 30-day TTL. Keyed by SHA-256 hash of the input content. Prevents redundant AI calls for products with identical `product_details`.

### cil.enrichment_jobs

Job history for accordion generation and quality scoring. Cursor-based — every job records `last_processed_asin` so it can be resumed at any point.

### cil.facet_configs

Per-category Algolia facet configurations generated by `families/generate`. The frontend reads this to know which filters to show on a given category listing page.

---

## Useful Queries

```sql
-- Product count per department
SELECT taxonomy_dept, COUNT(*) AS product_count
FROM store.products
WHERE is_active = true
GROUP BY taxonomy_dept
ORDER BY product_count DESC;

-- Quality score distribution
SELECT
  COUNT(*) FILTER (WHERE quality_score >= 80) AS high,
  COUNT(*) FILTER (WHERE quality_score BETWEEN 50 AND 79) AS medium,
  COUNT(*) FILTER (WHERE quality_score < 50) AS low,
  ROUND(AVG(quality_score), 1) AS avg_score
FROM cil.product_quality;

-- Products not yet scored by CIL
SELECT COUNT(*) FROM store.products sp
LEFT JOIN cil.product_quality q ON q.asin = sp.asin
WHERE sp.is_active = true AND q.asin IS NULL;

-- catalog.products sync health check
SELECT
  (SELECT COUNT(*) FROM store.products WHERE is_active = true) AS store_count,
  (SELECT COUNT(*) FROM catalog.products WHERE is_active = true) AS catalog_count;
-- These two numbers should always match.

-- Families with good schema coverage
SELECT name, taxonomy_path::text, schema_coverage, last_ai_review
FROM cil.attribute_families
WHERE schema_coverage >= 60
ORDER BY schema_coverage DESC;
```

---

## LTREE Path Format

Taxonomy paths follow this pattern:

```
dept_slug               → depth 1 (department)
dept_slug.subcat_slug   → depth 2 (subcategory)
```

Special characters in department/subcategory names are replaced with underscores:

```
"Beauty and Personal Care"  →  beauty_and_personal_care
"Toners & Astringents"      →  toners_astringents
"Tools & Home Improvement"  →  tools_home_improvement
```

LTREE ancestor operator `<@`:

```sql
-- "Is this product in Electronics or any subcategory of Electronics?"
taxonomy_path <@ 'electronics'::ltree

-- "Is this product exactly in the headphones subcategory?"
taxonomy_path = 'electronics.headphones'::ltree
```
