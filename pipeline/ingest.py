#!/usr/bin/env python3
"""
pipeline/ingest.py — Enterprise ETL: products_discovery_enhanced.jsonl → PostgreSQL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Architecture
  • Streams JSONL line-by-line (never loads the full file into RAM)
  • Validates each record with Pydantic v2 — invalid records quarantined
  • asyncpg for async PostgreSQL batch upserts
  • Structured JSON logging (structlog)
  • Rich progress bar + live stats

Dataset: pikly (replaces oxylabs)
Schema version: v5.0.0 — 2026-04

Usage
  python ingest.py [JSONL_FILE] [OPTIONS]
  python ingest.py --help

Examples
  python ingest.py ../api/data/products_discovery_enhanced.jsonl
  python ingest.py ../api/data/products_discovery_enhanced.jsonl --batch 500
  python ingest.py ../api/data/products_discovery_enhanced.jsonl --limit 200 --dry-run
  python ingest.py ../api/data/products_discovery_enhanced.jsonl --clear
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import asyncpg
import orjson
import structlog
import typer
from dotenv import load_dotenv
from pydantic import ValidationError
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn, MofNCompleteColumn, Progress,
    SpinnerColumn, TextColumn, TimeElapsedColumn, TimeRemainingColumn,
)
from rich.table import Table

from validate import EnrichedProduct
from transform import to_db_row

load_dotenv()
log     = structlog.get_logger()
console = Console()
app     = typer.Typer(help='Pikly ETL pipeline — JSONL → PostgreSQL (v5.0.0)')

# ── DB columns ────────────────────────────────────────────────────────────────

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
    # ── migration 004 / pikly ─────────────────────────────────────────────────
    'thumbnails',              # TEXT[]  — NOT in JSONB_COLS
    'sponsored_brands',        # JSONB
    'product_description',     # JSONB
    'search_metadata',         # JSONB
    'search_parameters',       # JSONB
    'enrichment_source_data',  # JSONB
]

# JSONB columns — must be pre-serialised to JSON strings before passing to asyncpg.
# 'thumbnails' is TEXT[] — intentionally excluded.
JSONB_COLS = frozenset({
    'product_results', 'purchase_options', 'protection_plan',
    'item_specs', 'about_item', 'bought_together', 'related_products',
    'product_details', 'accordion_content', 'reviews_info',
    'category_breadcrumb', 'videos', 'shipping_fees', 'flags', 'bestsellers_rank',
    'sponsored_brands', 'product_description',
    'search_metadata', 'search_parameters', 'enrichment_source_data',
})

# SQL: JSONB columns get an explicit ::jsonb cast so asyncpg sends them correctly.
def _make_param(i: int, col: str) -> str:
    return f'${i+1}::jsonb' if col in JSONB_COLS else f'${i+1}'

UPDATE_CLAUSE = ',\n    '.join(
    f'{c} = EXCLUDED.{c}' for c in COLUMNS if c != 'asin'
) + ',\n    updated_at = NOW()'

UPSERT_SQL = f"""
INSERT INTO store.products ({', '.join(COLUMNS)})
VALUES ({', '.join(_make_param(i, col) for i, col in enumerate(COLUMNS))})
ON CONFLICT (asin) DO UPDATE SET
    {UPDATE_CLAUSE}
"""


# ── Row serialiser ────────────────────────────────────────────────────────────

def _to_record(row: dict[str, Any]) -> tuple:
    """Convert a transform row dict → asyncpg-ready tuple.

    JSONB columns are pre-serialised to JSON strings (matched with ::jsonb cast
    in the SQL).  All other columns are passed as-is — asyncpg handles native
    Python types (bool, int, float, list[str]) automatically.
    """
    return tuple(
        json.dumps(row[col], default=str) if col in JSONB_COLS else row[col]
        for col in COLUMNS
    )


# ── Upsert (no retry decorator — errors surface immediately) ──────────────────

async def _upsert_batch(pool: asyncpg.Pool, records: list[tuple]) -> None:
    """Execute one batch upsert.  Raises on failure so the caller can log it."""
    async with pool.acquire() as conn:
        await conn.executemany(UPSERT_SQL, records)


# ── CLI entry point ───────────────────────────────────────────────────────────

@app.command()
def main(
    jsonl_file: Path = typer.Argument(
        None,
        help='Path to products_discovery_enhanced.jsonl.',
    ),
    batch:   int  = typer.Option(300,   help='Rows per database batch.'),
    limit:   int  = typer.Option(0,     help='Stop after N records (0 = all).'),
    clear:   bool = typer.Option(False, '--clear',   help='TRUNCATE store.products first.'),
    dry_run: bool = typer.Option(False, '--dry-run', help='Validate + transform only; no DB writes.'),
    quarantine_dir: Path = typer.Option(
        Path('quarantine'), '--quarantine', help='Dir for invalid records.',
    ),
) -> None:
    asyncio.run(_async_main(jsonl_file, batch, limit, clear, dry_run, quarantine_dir))


async def _async_main(
    jsonl_file:     Path | None,
    batch_size:     int,
    limit:          int,
    clear:          bool,
    dry_run:        bool,
    quarantine_dir: Path,
) -> None:

    # ── Resolve input file ────────────────────────────────────────────────────
    candidates = [
        jsonl_file,
        Path(os.environ.get('JSONL_FILE', '')),
        Path('../api/data/products_discovery_enhanced.jsonl'),
        Path('data/products_discovery_enhanced.jsonl'),
        Path('../api/data/products_cleaned.jsonl'),
        Path('data/products_cleaned.jsonl'),
    ]
    resolved: Path | None = next((p for p in candidates if p and p.exists()), None)
    if resolved is None:
        console.print('[bold red]❌  No JSONL file found.[/]')
        raise typer.Exit(1)

    db_url = os.environ.get('DATABASE_URL', '')
    if not db_url and not dry_run:
        console.print('[bold red]❌  DATABASE_URL not set.[/]')
        raise typer.Exit(1)

    console.print(Panel(
        f'[bold cyan]Pikly ETL Pipeline[/] — v5.0.0\n'
        f'File    : [green]{resolved}[/] ({resolved.stat().st_size / 1_048_576:.1f} MB)\n'
        f'Batch   : {batch_size}  |  Limit : {limit or "∞"}  |  Dry-run : {dry_run}',
        title='[bold white]⚡ Product Ingest',
    ))

    # ── Quarantine ────────────────────────────────────────────────────────────
    quarantine_dir.mkdir(parents=True, exist_ok=True)
    quarantine_file = quarantine_dir / f'invalid_{int(time.time())}.jsonl'
    q_fh = open(quarantine_file, 'w', encoding='utf-8')

    # ── PostgreSQL pool ───────────────────────────────────────────────────────
    pool: asyncpg.Pool | None = None
    if not dry_run:
        pool = await asyncpg.create_pool(db_url, min_size=2, max_size=8, ssl='require')
        log.info('postgresql_connected')

        if clear:
            async with pool.acquire() as conn:
                await conn.execute('TRUNCATE store.products CASCADE')
            log.info('table_truncated')

    # ── Progress bar ──────────────────────────────────────────────────────────
    progress = Progress(
        SpinnerColumn(),
        TextColumn('[bold blue]{task.description}'),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        console=console,
    )
    task = progress.add_task('Ingesting…', total=limit or None)

    stats: dict[str, int] = {
        'total': 0, 'valid': 0, 'invalid': 0, 'upserted': 0, 'batches': 0,
    }
    failed_batches: list[str] = []   # collect errors — print AFTER progress closes
    pending: list[tuple] = []
    seen_slugs: set[str] = set()

    # ── Flush helper ──────────────────────────────────────────────────────────
    async def flush() -> None:
        if not pending or dry_run or pool is None:
            pending.clear()
            return
        try:
            await _upsert_batch(pool, list(pending))   # pass a snapshot
            stats['upserted'] += len(pending)
            stats['batches']  += 1
        except Exception as exc:
            # Store error — print after progress bar closes so it's visible
            msg = f"Batch {stats['batches']+1}: {str(exc)[:400]}"
            failed_batches.append(msg)
            log.error('batch_failed', error=str(exc)[:200])
        pending.clear()

    # ── Stream file ───────────────────────────────────────────────────────────
    t0 = time.monotonic()

    with progress:
        with open(resolved, 'rb') as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue

                stats['total'] += 1
                if limit and stats['total'] > limit:
                    break

                # Parse JSON
                try:
                    raw: dict = orjson.loads(line)
                except Exception:
                    stats['invalid'] += 1
                    q_fh.write(line.decode('utf-8', errors='replace') + '\n')
                    continue

                # Validate
                try:
                    product = EnrichedProduct.model_validate(raw)
                except ValidationError as exc:
                    stats['invalid'] += 1
                    q_fh.write(json.dumps({'_error': exc.errors(), '_raw': raw}) + '\n')
                    log.warning('validation_failed', asin=raw.get('asin', '?'))
                    continue

                # Transform
                try:
                    row = to_db_row(product)
                except Exception as exc:
                    stats['invalid'] += 1
                    log.error('transform_failed', asin=product.asin, error=str(exc))
                    continue

                # Deduplicate slugs within run
                slug = row['slug']
                if slug in seen_slugs:
                    row['slug'] = f"{slug}-{stats['total']}"
                seen_slugs.add(row['slug'])

                stats['valid'] += 1
                pending.append(_to_record(row))

                if len(pending) >= batch_size:
                    await flush()

                progress.advance(task)

        await flush()   # final partial batch

    q_fh.close()
    elapsed = time.monotonic() - t0

    # ── Print any batch errors NOW (outside progress context — fully visible) ──
    if failed_batches:
        console.print('\n[bold red]━━━ BATCH ERRORS ━━━[/]')
        for msg in failed_batches:
            console.print(f'[red]❌ {msg}[/]')
        console.print()

    # ── Final DB count ────────────────────────────────────────────────────────
    active_count = 0
    if pool:
        async with pool.acquire() as conn:
            active_count = await conn.fetchval(
                'SELECT COUNT(*) FROM store.products WHERE is_active = true'
            )
        await pool.close()

    # ── Summary ───────────────────────────────────────────────────────────────
    t = Table(title='✅  Ingest Complete', show_header=True, header_style='bold magenta')
    t.add_column('Metric', style='cyan')
    t.add_column('Value',  style='green', justify='right')
    t.add_row('Records processed',     f"{stats['total']:,}")
    t.add_row('Valid',                 f"{stats['valid']:,}")
    t.add_row('Invalid (quarantined)', f"{stats['invalid']:,}")
    t.add_row('DB batches',            f"{stats['batches']:,}")
    t.add_row('Upserted',              f"{stats['upserted']:,}")
    t.add_row('Active in DB',          f"{active_count:,}")
    t.add_row('Elapsed',               f"{elapsed:.1f}s")
    t.add_row('Throughput',            f"{stats['total']/elapsed:,.0f} rec/s")
    if stats['invalid']:
        t.add_row('Quarantine file', str(quarantine_file))
    console.print(t)

    log.info('ingest_complete', **stats, active_in_db=active_count, elapsed_s=round(elapsed, 2))


if __name__ == '__main__':
    app()
