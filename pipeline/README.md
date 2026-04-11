# Python ETL Pipeline

The pipeline transforms `products_cleaned.jsonl` into a PostgreSQL database, optionally enriched with AI-powered product recommendations.

---

## Components

| File | Purpose |
|---|---|
| `hybrid_discovery_engine.py` | Generates `bought_together` and `related_products` via BM25 + semantic embeddings |
| `ingest.py` | Streaming async ETL: validates → transforms → upserts into PostgreSQL |
| `validate.py` | Pydantic v2 schemas for the `products_cleaned.jsonl` record format |
| `transform.py` | Pure transformation functions (no I/O, fully testable) |

---

## Installation

```bash
cd pipeline
pip install -r requirements.txt
```

Requirements include: `asyncpg`, `pydantic`, `orjson`, `rich`, `structlog`, `sentence-transformers`, `rank-bm25`, `nltk`, `numpy`.

---

## Recommended Workflow

### Option A — With Discovery Engine (production quality)

Run the discovery engine first to generate AI-powered recommendations:

```bash
python hybrid_discovery_engine.py \
  --input ../api/data/products_cleaned.jsonl \
  --output ../api/data/products_discovery_enhanced.jsonl
```

Then ingest the enhanced file:

```bash
DATABASE_URL="postgresql://..." python ingest.py \
  ../api/data/products_discovery_enhanced.jsonl \
  --batch 300
```

### Option B — Direct ingest (quick start)

Skip the discovery engine and ingest directly. `bought_together` and `related_products` will be empty arrays:

```bash
DATABASE_URL="postgresql://..." python ingest.py \
  ../api/data/products_cleaned.jsonl \
  --batch 300
```

---

## ingest.py Options

```
python ingest.py [JSONL_FILE] [OPTIONS]

Arguments:
  JSONL_FILE    Path to JSONL file (or set JSONL_FILE env var)

Options:
  --batch INT   Rows per database batch (default: 300)
  --limit INT   Stop after N records — useful for test runs (default: 0 = all)
  --clear       TRUNCATE store.products before ingesting
  --dry-run     Validate and transform only, no DB writes
  --quarantine  Directory for invalid records (default: quarantine/)
```

**Examples:**

```bash
# Test run with 100 products
python ingest.py data.jsonl --limit 100

# Dry run — validate all records without writing
python ingest.py data.jsonl --dry-run

# Full fresh ingest
python ingest.py data.jsonl --clear --batch 300
```

---

## hybrid_discovery_engine.py Options

```
python hybrid_discovery_engine.py [OPTIONS]

Options:
  --input PATH    Input JSONL file (default: looks for products_cleaned.jsonl)
  --output PATH   Output JSONL file (default: products_discovery_enhanced.jsonl)
```

### How it works

1. **BM25 keyword layer** — Uses `rank_bm25` with Porter stemming on product titles. Fast, no GPU needed.
2. **Semantic layer** — Uses `all-MiniLM-L6-v2` (80 MB model) to encode product titles into 384-dimensional embeddings and compute cosine similarity.
3. **Reciprocal Rank Fusion (RRF)** — Combines BM25 and semantic rankings with `k=60`. RRF is robust to score scale differences.
4. **Cross-category map** — `bought_together` suggestions come from complementary categories (e.g. Skin Care → Spa Tools) rather than same-category items.

**Output format** added to each record:
```json
{
  "related_products": {
    "similar": [
      { "asin": "B001XYZ", "title": "...", "score": 0.92 }
    ],
    "bought_together": [
      { "asin": "B002ABC", "title": "...", "score": 0.78 }
    ]
  }
}
```

The seeder (`seed-pg.ts` and `ingest.py`) picks up this top-level key and stores:
- `similar` → `store.products.related_products`
- `bought_together` → `store.products.bought_together`

---

## validate.py — Schema

Records from `products_cleaned.jsonl` are validated with Pydantic v2 before transformation. Invalid records are **quarantined** (written to `quarantine/invalid_<timestamp>.jsonl`) and skipped — the pipeline never crashes on bad data.

Top-level schema:

```python
class EnrichedProduct(BaseModel):
    asin:                  str                  # required, non-empty
    source:                str = 'pikly'
    data:                  DataBlob
    _taxonomy:             Taxonomy             # { department, subcategory }
    _flags:                Flags                # { isPrime, inStock, ... }
    enrichment_source_data: dict = {}           # pikly-specific enrichment
```

---

## transform.py — Key Transformations

- **LTREE path** — not computed here; handled by the PostgreSQL trigger on `store.products`
- **thumbnails** — prefers `product_results.highResolutionImages` over `product_results.thumbnails`
- **discount_pct** — computed from `extracted_price` vs `extracted_old_price`
- **attr_values** — merged from `item_specifications` + `product_details`, formatted as `key:value`
- **bought_together / related_products** — sourced from the Discovery Engine output (`raw.related_products.bought_together` / `.similar`), NOT from the raw scraper data

---

## Environment Variables

```bash
DATABASE_URL=postgresql://...   # required
JSONL_FILE=/path/to/file.jsonl  # optional alternative to CLI argument

# Discovery engine cache paths (auto-resolved from home dir if not set)
NLTK_DATA=/path/to/nltk_data
TRANSFORMERS_CACHE=/path/to/transformers_cache
```
