"""
debug_ingest.py — Simple ingest without Rich to see real errors
Run: python debug_ingest.py
"""
import asyncio, json, os, sys
from pathlib import Path
from dotenv import load_dotenv
import asyncpg, orjson
from pydantic import ValidationError

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent))
from validate import EnrichedProduct
from transform import to_db_row

JSONL_FILE = Path('../api/data/products_discovery_enhanced.jsonl')
DATABASE_URL = os.environ.get('DATABASE_URL', '')
BATCH_SIZE = 50  # small batch to test

JSONB_COLS = frozenset({
    'product_results', 'purchase_options', 'protection_plan',
    'item_specs', 'about_item', 'bought_together', 'related_products',
    'product_details', 'accordion_content', 'reviews_info',
    'category_breadcrumb', 'videos', 'shipping_fees', 'flags', 'bestsellers_rank',
    'sponsored_brands', 'product_description', 'search_metadata',
    'search_parameters', 'enrichment_source_data',
})

COLUMNS = [
    'asin', 'slug', 'is_active', 'source',
    'taxonomy_dept', 'taxonomy_subcat',
    'title', 'brand', 'price', 'original_price', 'discount_pct',
    'avg_rating', 'review_count', 'bought_last_month', 'thumbnail',
    'is_prime', 'is_free_ship', 'in_stock',
    'is_best_seller', 'is_trending', 'is_top_rated', 'is_on_sale',
    'is_amazon_choice', 'is_new_release', 'is_deal',
    'cat_lvl0', 'cat_lvl1', 'cat_lvl2', 'cat_lvl3',
    'colors', 'sizes', 'attr_values',
    'product_results', 'purchase_options', 'protection_plan',
    'item_specs', 'about_item', 'bought_together', 'related_products',
    'product_details', 'accordion_content', 'reviews_info',
    'category_breadcrumb', 'videos', 'shipping_fees', 'flags', 'bestsellers_rank',
    'thumbnails', 'sponsored_brands', 'product_description',
    'search_metadata', 'search_parameters', 'enrichment_source_data',
]

def make_param(i, col):
    return f'${i+1}::jsonb' if col in JSONB_COLS else f'${i+1}'

UPDATE_CLAUSE = ',\n    '.join(
    f'{c} = EXCLUDED.{c}' for c in COLUMNS if c != 'asin'
) + ',\n    updated_at = NOW()'

UPSERT_SQL = f"""
INSERT INTO store.products ({', '.join(COLUMNS)})
VALUES ({', '.join(make_param(i, col) for i, col in enumerate(COLUMNS))})
ON CONFLICT (asin) DO UPDATE SET
    {UPDATE_CLAUSE}
"""

async def main():
    print(f"DATABASE_URL: {DATABASE_URL[:50]}...")
    print(f"JSONL FILE: {JSONL_FILE} exists={JSONL_FILE.exists()}")

    # Connect
    print("\nConnecting to DB...")
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=2, ssl='require')
    print("✅ Connected!")

    # Read first BATCH_SIZE valid products
    rows = []
    print(f"\nReading first {BATCH_SIZE} products from JSONL...")
    with open(JSONL_FILE, 'rb') as fh:
        for raw_line in fh:
            if len(rows) >= BATCH_SIZE:
                break
            line = raw_line.strip()
            if not line:
                continue
            try:
                raw = orjson.loads(line)
                product = EnrichedProduct.model_validate(raw)
                row = to_db_row(product)
                rows.append(row)
            except Exception as e:
                print(f"  Skip: {e}")
                continue

    print(f"✅ Got {len(rows)} rows to insert")

    # Try inserting
    print(f"\nInserting {len(rows)} rows...")
    records = [
        tuple(
            json.dumps(row[col], default=str) if col in JSONB_COLS else row[col]
            for col in COLUMNS
        )
        for row in rows
    ]

    try:
        async with pool.acquire() as conn:
            await conn.executemany(UPSERT_SQL, records)
        print(f"✅ Inserted {len(rows)} rows successfully!")
    except Exception as e:
        print(f"❌ INSERT ERROR: {e}")
        # Try single row to isolate which column fails
        print("\nTrying single row insert...")
        try:
            async with pool.acquire() as conn:
                await conn.executemany(UPSERT_SQL, [records[0]])
            print("✅ Single row worked!")
        except Exception as e2:
            print(f"❌ Single row also failed: {e2}")
            # Print what types each column has
            print("\nColumn types for first row:")
            for col, val in zip(COLUMNS, records[0]):
                print(f"  {col}: {type(val).__name__} = {str(val)[:50]}")

    count = await pool.fetchval('SELECT COUNT(*) FROM store.products')
    print(f"\nTotal products in DB: {count}")
    await pool.close()

asyncio.run(main())
