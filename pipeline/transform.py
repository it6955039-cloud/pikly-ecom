"""
pipeline/transform.py — Pure transformation functions.
No I/O, no async — these are stateless data converters.
Every function returns a plain dict ready for asyncpg insertion.

Schema version: v5.1.0 — 2026-04
Changes vs v5.0.0:
  • cat_lvl0–3: now derived from data.category Amazon breadcrumb instead of
    _taxonomy slugs.  cat_lvl2 and cat_lvl3 are populated for the first time.
    Format follows Algolia hierarchical-facets standard: each level is a
    cumulative "A > B > C" human-readable string.
    Falls back to _taxonomy when breadcrumb is absent or truncated.

Changes vs v4:
  • 6 new DB columns (migration 004): thumbnails, sponsored_brands,
    product_description, search_metadata, search_parameters,
    enrichment_source_data
  • bought_together / related_products: OVERRIDDEN by Discovery Engine output.
    Scraper values are SILENTLY DROPPED. Engine output lives in model_extra
    under the key 'related_products' as { similar: [...], bought_together: [...] }
  • thumbnails: prefers highResolutionImages over thumbnails (pikly provides both)
  • helpful_votes: raw string or int — normalised by _parse_helpful_votes()
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from validate import EnrichedProduct


# ── Slug helpers ───────────────────────────────────────────────────────────────

_SLUG_RE = re.compile(r'[^a-z0-9\s-]')
_SPACES  = re.compile(r'[\s_-]+')


def slugify(text: str, max_len: int = 80) -> str:
    s = _SLUG_RE.sub(' ', text.lower())
    s = _SPACES.sub('-', s).strip('-')
    return s[:max_len].rstrip('-')


def asin_slug(title: str, asin: str) -> str:
    """Deterministic slug: <title-prefix>-<asin>-<hash6>"""
    base = slugify(title[:60])
    slug = f"{base}-{asin.lower()}"
    h6   = hashlib.md5(asin.encode()).hexdigest()[:6]
    return f"{slug}-{h6}"[:120]


# ── Variant extraction ─────────────────────────────────────────────────────────

def extract_colors_sizes(variants: list[dict]) -> tuple[list[str], list[str]]:
    colors: list[str] = []
    sizes:  list[str] = []
    for vg in variants:
        title_lower = (vg.get('title') or '').lower()
        for item in (vg.get('items') or []):
            name = item.get('name')
            if not name:
                continue
            if 'color' in title_lower and name not in colors:
                colors.append(name)
            elif 'size' in title_lower and name not in sizes:
                sizes.append(name)
    return colors, sizes


# ── Attribute values (Algolia faceting) ────────────────────────────────────────

_SKIP_ATTR = frozenset({
    'asin', 'rating', 'reviews', 'customer_reviews',
    'best_sellers_rank', 'upc', 'global_trade_identification_number',
})


def extract_attr_values(item_specs: dict, product_details: dict) -> list[str]:
    merged = {**item_specs, **product_details}
    out: list[str] = []
    for k, v in merged.items():
        if k in _SKIP_ATTR:
            continue
        sv = str(v).strip()
        if sv and len(sv) < 100:
            out.append(f"{k}:{sv}")
    return out


# ── Discount ──────────────────────────────────────────────────────────────────

def compute_discount(price: float, old_price: float | None) -> int:
    if price and old_price and old_price > price:
        return round((1 - price / old_price) * 100)
    return 0


# ── Helpful votes normaliser ──────────────────────────────────────────────────
#
# oxylabs: "84 people found this helpful" (string)
# pikly:   "" or "2 people found this helpful" or int
# Both are now handled identically.

def _parse_helpful_votes(v: Any) -> int:
    if isinstance(v, int):
        return v
    m = re.search(r'\d+', str(v or ''))
    return int(m.group()) if m else 0


# ── Amazon breadcrumb → Algolia hierarchical cat_lvl* ────────────────────────
#
# data.category is a list of {name, link} dicts scraped from Amazon's
# breadcrumb trail, e.g.:
#   [{"name": "Beauty & Personal Care"}, {"name": "Skin Care"},
#    {"name": "Face"}, {"name": "Toners & Astringents"}]
#
# Algolia hierarchical facets require CUMULATIVE human-readable strings:
#   lvl0: "Beauty & Personal Care"
#   lvl1: "Beauty & Personal Care > Skin Care"
#   lvl2: "Beauty & Personal Care > Skin Care > Face"
#   lvl3: "Beauty & Personal Care > Skin Care > Face > Toners & Astringents"
#
# Falls back gracefully to _taxonomy when breadcrumb is absent or shorter
# than the requested level.

def _build_cat_levels(
    category_breadcrumb: list[Any],
    dept: str,
    subcat: str,
) -> tuple[str, str | None, str | None, str | None]:
    """
    Returns (cat_lvl0, cat_lvl1, cat_lvl2, cat_lvl3).

    Uses data.category Amazon breadcrumb as the primary source.
    Falls back to _taxonomy.department / _taxonomy.subcategory when the
    breadcrumb is absent or does not reach a given depth.
    """
    # Extract clean, non-empty names from the breadcrumb list.
    # Rules:
    #   - dicts:   read 'name' key (scraper standard format)
    #   - strings: use as-is (defensive against schema drift)
    #   - anything else (None, int, list, ...): skip silently.
    #     NEVER coerce unknown types to str — str(None)="None" and
    #     str(42)="42" would silently corrupt category paths.
    names: list[str] = []
    for item in (category_breadcrumb or []):
        if isinstance(item, dict):
            name = (item.get('name') or '').strip()
        elif isinstance(item, str):
            name = item.strip()
        else:
            continue  # None, int, list, or any unexpected type — skip
        if name:
            names.append(name)

    # lvl0 — top category name; fall back to _taxonomy.department
    lvl0: str = names[0] if names else dept

    # lvl1 — use breadcrumb[1] if present; else fall back to _taxonomy.subcategory
    if len(names) >= 2:
        lvl1: str | None = f"{lvl0} > {names[1]}"
    elif subcat:
        lvl1 = f"{lvl0} > {subcat}"
    else:
        lvl1 = None

    # lvl2 / lvl3 — only populated when the breadcrumb is deep enough
    lvl2: str | None = (
        f"{lvl1} > {names[2]}" if (lvl1 is not None and len(names) >= 3) else None
    )
    lvl3: str | None = (
        f"{lvl2} > {names[3]}" if (lvl2 is not None and len(names) >= 4) else None
    )

    return lvl0, lvl1, lvl2, lvl3


# ── Engine discovery output extractor ─────────────────────────────────────────
#
# After hybrid_discovery_engine.py runs it injects a top-level key:
#   product['related_products'] = { 'similar': [...], 'bought_together': [...] }
#
# This is captured in EnrichedProduct.model_extra because the field name
# collides with DataBlob.related_products (which is scraper data we discard).
#
# Priority: engine output > scraper data > []

def _engine_discovery(product: EnrichedProduct) -> tuple[list[Any], list[Any]]:
    """
    Returns (related_products, bought_together) from engine output.
    Falls back to empty lists — scraper values are intentionally discarded.
    """
    engine_rp: dict[str, Any] = product.model_extra.get('related_products', {})  # type: ignore[union-attr]
    if isinstance(engine_rp, dict):
        related       = list(engine_rp.get('similar', []))
        bought_tog    = list(engine_rp.get('bought_together', []))
    else:
        # Safety: model_extra could theoretically hold a list if schema drifts
        related    = []
        bought_tog = []
    return related, bought_tog


# ── Main transform ─────────────────────────────────────────────────────────────

def to_db_row(product: EnrichedProduct) -> dict[str, Any]:
    """
    Convert a validated EnrichedProduct into a flat dict that maps 1-to-1
    with store.products columns.  All JSONB columns are passed as Python
    dicts/lists — asyncpg will serialise them natively.
    """
    pr    = product.data.product_results
    pd    = product.data.product_details
    tax   = product.taxonomy
    flags = product.flags

    title  = pr.get('title', '')
    brand  = re.sub(r'^Visit the\s+|\s+Store\s*$', '', pr.get('brand', ''), flags=re.I).strip()
    price  = float(pr.get('extracted_price') or 0)
    old_px = pr.get('extracted_old_price')
    old_px = float(old_px) if old_px else None

    dept   = (tax.department  or '')[:200]
    subcat = (tax.subcategory or '')[:200]

    # Build Algolia hierarchical category levels from Amazon breadcrumb.
    # See _build_cat_levels() for full rationale and fallback behaviour.
    cat_lvl0, cat_lvl1, cat_lvl2, cat_lvl3 = _build_cat_levels(
        list(product.data.category), dept, subcat,
    )

    colors, sizes = extract_colors_sizes(pr.get('variants', []))
    attr_values   = extract_attr_values(
        product.data.item_specifications,
        pd if isinstance(pd, dict) else {},
    )

    in_stock_raw = (pr.get('stock') or '').lower()
    in_stock     = flags.inStock if flags.inStock is not None else ('in stock' in in_stock_raw)

    # ── Discovery Engine output (replaces scraper bt/rp) ─────────────────────
    engine_related, engine_bought_together = _engine_discovery(product)

    # ── pikly new fields ──────────────────────────────────────────────────────
    # thumbnails: prefer highResolutionImages (pikly-only) → thumbnails → []
    thumbnails: list[str] = (
        pr.get('highResolutionImages')
        or pr.get('thumbnails')
        or []
    )

    # search_metadata / search_parameters live inside DataBlob.model_extra
    data_extras = product.data.model_extra or {}

    return {
        # ── Identity ──────────────────────────────────────────────────────────
        'asin':             product.asin,
        'slug':             asin_slug(title, product.asin),
        'is_active':        True,
        'source':           product.source,

        # ── Taxonomy ──────────────────────────────────────────────────────────
        'taxonomy_dept':   dept,
        'taxonomy_subcat': subcat,

        # ── Denormalised scalars ───────────────────────────────────────────────
        'title':            title[:500],
        'brand':            brand[:200],
        'price':            price,
        'original_price':   old_px,
        'discount_pct':     compute_discount(price, old_px),
        'avg_rating':       float(pr.get('rating') or 0),
        'review_count':     int(pr.get('reviews') or 0),
        'bought_last_month':pr.get('bought_last_month') or None,
        'thumbnail':        pr.get('thumbnail') or None,

        # ── Boolean flags ──────────────────────────────────────────────────────
        'is_prime':         flags.isPrime,
        'is_free_ship':     flags.isFreeShipping,
        'in_stock':         in_stock,
        'is_best_seller':   flags.isBestSeller,
        'is_trending':      flags.isTrending,
        'is_top_rated':     flags.isTopRated,
        'is_on_sale':       flags.isOnSale,
        'is_amazon_choice': flags.isAmazonsChoice,
        'is_new_release':   flags.isNewRelease,
        'is_deal':          flags.isDeal,

        # ── Algolia hierarchical categories ────────────────────────────────────
        'cat_lvl0':        cat_lvl0,
        'cat_lvl1':        cat_lvl1,
        'cat_lvl2':        cat_lvl2,
        'cat_lvl3':        cat_lvl3,

        # ── Multi-value facet arrays ────────────────────────────────────────────
        'colors':          colors,
        'sizes':           sizes,
        'attr_values':     attr_values,

        # ── Full JSONB blobs ────────────────────────────────────────────────────
        'product_results':  dict(product.data.product_results),
        'purchase_options': dict(product.data.purchase_options),
        'protection_plan':  list(product.data.protection_plan),
        'item_specs':       dict(product.data.item_specifications),
        'about_item':       list(product.data.about_item),

        # bought_together / related_products: engine output ONLY.
        # Scraper values from data.bought_together / data.related_products
        # are intentionally discarded here.
        'bought_together':  engine_bought_together,
        'related_products': engine_related,

        'product_details':     dict(pd) if isinstance(pd, dict) else {},
        'accordion_content':   list(product.data.accordionContent),
        'reviews_info':        dict(product.data.reviews_information),
        'category_breadcrumb': list(product.data.category),
        'videos':              list(product.data.videos),
        'shipping_fees':       dict(product.data.shippingFees),
        'flags': {
            'isBestSeller':    flags.isBestSeller,
            'isAmazonsChoice': flags.isAmazonsChoice,
            'isTrending':      flags.isTrending,
            'isHighlyPopular': flags.isHighlyPopular,
            'isNewRelease':    flags.isNewRelease,
            'isFreeShipping':  flags.isFreeShipping,
            'isPrime':         flags.isPrime,
            'isOnSale':        flags.isOnSale,
            'isDeal':          flags.isDeal,
            'isTopRated':      flags.isTopRated,
            'inStock':         in_stock,
        },
        'bestsellers_rank': pd.get('best_sellers_rank', []) if isinstance(pd, dict) else [],

        # ── NEW (migration 004 / pikly) ─────────────────────────────────────
        # TEXT[]  — no JSONB cast; asyncpg sends as native PG array
        'thumbnails': thumbnails,

        # JSONB columns
        'sponsored_brands':      list(product.data.sponsored_brands),
        'product_description':   list(product.data.product_description),
        'search_metadata':       data_extras.get('search_metadata', {}),
        'search_parameters':     data_extras.get('search_parameters', {}),
        'enrichment_source_data': dict(product.enrichment_source_data),
    }
