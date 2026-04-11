import asyncio, asyncpg, os, orjson
from dotenv import load_dotenv

load_dotenv()

async def test():
    url = os.environ.get('DATABASE_URL')

    # Pool banao — ingest.py jaisa
    pool = await asyncpg.create_pool(
        url, min_size=1, max_size=2, ssl='require',
        init=lambda c: c.set_type_codec(
            'jsonb', encoder=lambda v: orjson.dumps(v).decode(),
            decoder=orjson.loads, schema='pg_catalog',
        ),
    )

    # Ek dummy record insert karo
    try:
        async with pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO store.products (asin, slug, title, source)
                VALUES ('TEST001', 'test-product-001', 'Test Product', 'pikly')
                ON CONFLICT (asin) DO UPDATE SET title = EXCLUDED.title
            """)
            count = await conn.fetchval('SELECT COUNT(*) FROM store.products')
            print("✅ Insert worked! Total products:", count)
    except Exception as e:
        print("❌ Insert ERROR:", e)

    await pool.close()

asyncio.run(test())
