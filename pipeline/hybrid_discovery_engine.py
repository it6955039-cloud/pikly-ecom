#!/usr/bin/env python3
"""
pipeline/hybrid_discovery_engine.py
Hybrid Semantic + Keyword Discovery Engine — v2.0.0 — 2026-04

Transforms products_cleaned.jsonl (pikly source) into
products_discovery_enhanced.jsonl by:
  1. Stripping scraped bought_together / related_products from data blob
  2. Computing engine recommendations (Semantic RRF + BM25)
  3. Injecting engine output as top-level key:
       product['related_products'] = { 'similar': [...], 'bought_together': [...] }

This top-level key is picked up by transform.py during DB ingest and stored
in the DB's bought_together / related_products JSONB columns respectively.

Architecture:
  • Neural Semantic Layer  : sentence-transformers all-MiniLM-L6-v2 (80 MB)
  • Keyword Precision Layer: rank_bm25 with Porter Stemming
  • Rank Fusion            : Reciprocal Rank Fusion (RRF, k=60)
  • Cross-Category Semantic Map for complementary "Bought Together" suggestions
  • Memory-efficient: generator-based JSONL loading, batch JSONL saving
  • Cross-platform: cache dir resolved from env vars, never hard-coded

Usage:
  python hybrid_discovery_engine.py
  JSONL_FILE=/data/products_cleaned.jsonl python hybrid_discovery_engine.py
  python hybrid_discovery_engine.py --input /data/in.jsonl --output /data/out.jsonl
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict, Generator, List

import numpy as np
import orjson
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

# ── NLTK bootstrapping ─────────────────────────────────────────────────────────
# We resolve NLTK_DATA from env so the path is never hard-coded.
# If unset, default to ~/.cache/pikly/nltk_data (works on Linux/Mac/Windows).
_NLTK_DATA = os.environ.get(
    'NLTK_DATA',
    str(Path.home() / '.cache' / 'pikly' / 'nltk_data'),
)
os.environ.setdefault('NLTK_DATA', _NLTK_DATA)

import nltk  # noqa: E402 (import after env setup)
nltk.data.path.insert(0, _NLTK_DATA)

from nltk.stem import PorterStemmer  # noqa: E402


# ── Transformers cache ─────────────────────────────────────────────────────────
_TRANSFORMERS_CACHE = os.environ.get(
    'TRANSFORMERS_CACHE',
    str(Path.home() / '.cache' / 'pikly' / 'transformers'),
)
os.environ.setdefault('TRANSFORMERS_CACHE', _TRANSFORMERS_CACHE)


# ── Constants ──────────────────────────────────────────────────────────────────

MODEL_NAME    = 'all-MiniLM-L6-v2'
EMBEDDING_DIM = 384
BATCH_SIZE    = 500     # products saved per JSONL flush
TOP_K         = 10      # recommendations per product
RRF_K         = 60      # RRF constant

# Cross-category semantic map — used for "bought together" suggestions.
# Products in the same category are excluded in favour of complementary ones.
CROSS_CATEGORY_MAP: dict[str, str] = {
    'Skin Care':            'Spa Tools',
    'Spa Tools':            'Skin Care',
    'Electronics':          'Computer Accessories',
    'Computer Accessories': 'Electronics',
    'Home & Kitchen':       'Kitchen & Dining',
    'Kitchen & Dining':     'Home & Kitchen',
    'Beauty & Personal Care': 'Health & Household',
    'Health & Household':   'Beauty & Personal Care',
    'Sports & Outdoors':    'Health & Household',
    'Clothing':             'Shoes & Jewelry',
    'Shoes & Jewelry':      'Clothing',
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _product_text(product: Dict[str, Any]) -> str:
    """Canonical searchable text for a product."""
    pr    = product.get('data', {}).get('product_results', {})
    tax   = product.get('_taxonomy', {})
    title = pr.get('title', '')
    brand = pr.get('brand', '')
    dept  = tax.get('department', '')
    sub   = tax.get('subcategory', '')
    return f"{title} {brand} {dept} {sub}"


def _slim_card(product: Dict[str, Any]) -> Dict[str, Any]:
    """Minimal card written into engine discovery arrays."""
    pr = product.get('data', {}).get('product_results', {})
    return {
        'asin':      product['asin'],
        'title':     pr.get('title', ''),
        'thumbnail': pr.get('thumbnail', ''),
        'brand':     pr.get('brand', ''),
        'price':     pr.get('extracted_price', 0),
        'rating':    pr.get('rating', 0),
        'reviews':   pr.get('reviews', 0),
    }


def _strip_scraper_discovery(product: Dict[str, Any]) -> Dict[str, Any]:
    """
    Remove scraper-sourced bought_together / related_products from data blob.
    Engine values will be injected at top level instead.
    Original scraper data is preserved in enrichment_source_data for audit.
    """
    data = product.get('data', {})
    data.pop('bought_together', None)
    data.pop('related_products', None)
    product['data'] = data
    return product


# ── Setup ──────────────────────────────────────────────────────────────────────

def setup_environment() -> None:
    for d in [_NLTK_DATA, _TRANSFORMERS_CACHE]:
        Path(d).mkdir(parents=True, exist_ok=True)
    try:
        nltk.download('stopwords', download_dir=_NLTK_DATA, quiet=True)
    except Exception as exc:
        print(f'[WARN] NLTK download skipped: {exc}', file=sys.stderr)


# ── JSONL loader ───────────────────────────────────────────────────────────────

def load_products(file_path: str) -> Generator[Dict[str, Any], None, None]:
    with open(file_path, 'r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield orjson.loads(line)


# ── Semantic Engine ────────────────────────────────────────────────────────────

class SemanticEngine:
    def __init__(self) -> None:
        self.model      = SentenceTransformer(MODEL_NAME)
        self.embeddings: np.ndarray | None = None
        self.products:   List[Dict[str, Any]] = []

    def build_index(self, products: List[Dict[str, Any]]) -> None:
        texts = [_product_text(p) for p in products]
        self.embeddings = np.asarray(
            self.model.encode(texts, convert_to_numpy=True, show_progress_bar=True),
            dtype=np.float32,
        )
        self.products = products

    def search(self, query: Dict[str, Any], top_k: int = TOP_K) -> List[Dict[str, Any]]:
        assert self.embeddings is not None, 'build_index() must be called first'
        q_emb  = np.asarray(
            self.model.encode([_product_text(query)], convert_to_numpy=True)[0],
            dtype=np.float32,
        )
        sims   = np.dot(self.embeddings, q_emb)
        # Get top_k * 2 candidates then filter
        idxs   = np.argsort(sims)[::-1][:top_k * 2]
        result = []
        for i in idxs:
            p = self.products[i]
            if p['asin'] == query['asin']:
                continue
            if sims[i] < 0.4:
                break
            cp = p.copy()
            cp['_semantic_score'] = float(sims[i])
            result.append(cp)
            if len(result) >= top_k:
                break
        return result


# ── Keyword Engine ─────────────────────────────────────────────────────────────

class KeywordEngine:
    def __init__(self) -> None:
        self.stemmer  = PorterStemmer()
        self.bm25:    BM25Okapi | None = None
        self.products: List[Dict[str, Any]] = []

    def _tokenize(self, product: Dict[str, Any]) -> List[str]:
        tokens = _product_text(product).lower().split()
        return [self.stemmer.stem(t) for t in tokens if t.isalnum()]

    def build_index(self, products: List[Dict[str, Any]]) -> None:
        self.products = products
        self.bm25     = BM25Okapi([self._tokenize(p) for p in products])

    def search(self, query: Dict[str, Any], top_k: int = TOP_K) -> List[Dict[str, Any]]:
        assert self.bm25 is not None, 'build_index() must be called first'
        scores = self.bm25.get_scores(self._tokenize(query))
        idxs   = np.argsort(scores)[::-1][:top_k * 2]
        result = []
        for i in idxs:
            p = self.products[i]
            if p['asin'] == query['asin'] or scores[i] <= 0:
                continue
            cp = p.copy()
            cp['_keyword_score'] = float(scores[i])
            result.append(cp)
            if len(result) >= top_k:
                break
        return result


# ── Reciprocal Rank Fusion ─────────────────────────────────────────────────────

def rrf_fuse(
    semantic: List[Dict[str, Any]],
    keyword:  List[Dict[str, Any]],
    k: int = RRF_K,
) -> List[Dict[str, Any]]:
    scores: dict[str, float] = {}
    by_asin: dict[str, Dict[str, Any]] = {}

    for rank, p in enumerate(semantic):
        asin = p['asin']
        scores[asin]  = scores.get(asin, 0.0) + 1 / (k + rank + 1)
        by_asin[asin] = p

    for rank, p in enumerate(keyword):
        asin = p['asin']
        scores[asin]  = scores.get(asin, 0.0) + 1 / (k + rank + 1)
        by_asin.setdefault(asin, p)

    fused = sorted(by_asin.values(), key=lambda x: scores[x['asin']], reverse=True)
    for p in fused:
        p['_rrf_score'] = scores[p['asin']]
    return fused[:TOP_K]


# ── Bought Together (cross-category) ──────────────────────────────────────────

def find_bought_together(
    product: Dict[str, Any],
    semantic: SemanticEngine,
) -> List[Dict[str, Any]]:
    dept          = product.get('_taxonomy', {}).get('department', '')
    target_dept   = CROSS_CATEGORY_MAP.get(dept, dept)
    candidates    = semantic.search(product, top_k=50)
    filtered      = [
        p for p in candidates
        if p.get('_taxonomy', {}).get('department') == target_dept
    ]
    return filtered[:5]


# ── Main ───────────────────────────────────────────────────────────────────────

def resolve_input(cli_input: str | None) -> str:
    candidates = [
        cli_input or '',
        os.environ.get('JSONL_FILE', ''),
        '../api/data/products_cleaned.jsonl',
        'data/products_cleaned.jsonl',
        'products_cleaned.jsonl',
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    raise FileNotFoundError(
        'products_cleaned.jsonl not found. '
        'Provide --input or set JSONL_FILE env var.'
    )


def process(input_file: str, output_file: str) -> None:
    setup_environment()

    print(f'[INFO] Loading products from {input_file}…')
    all_products = list(load_products(input_file))
    print(f'[INFO] Loaded {len(all_products):,} products')

    print('[INFO] Building semantic index…')
    sem_engine = SemanticEngine()
    sem_engine.build_index(all_products)

    print('[INFO] Building keyword (BM25) index…')
    kw_engine = KeywordEngine()
    kw_engine.build_index(all_products)

    # Clear output file
    out_path = Path(output_file)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    batch: List[Dict[str, Any]] = []
    total = len(all_products)

    for i, raw_product in enumerate(all_products):
        if (i + 1) % 100 == 0 or i == total - 1:
            print(f'  Processing {i+1:,}/{total:,} — {raw_product["asin"]}')

        # 1. Strip scraper discovery data (engine replaces it)
        product = _strip_scraper_discovery(raw_product)

        # 2. Compute engine recommendations
        sem_results = sem_engine.search(product)
        kw_results  = kw_engine.search(product)
        similar     = rrf_fuse(sem_results, kw_results)
        bought_tog  = find_bought_together(product, sem_engine)

        # 3. Inject at top level — transform.py reads from model_extra
        product['related_products'] = {
            'similar':        [_slim_card(p) for p in similar],
            'bought_together': [_slim_card(p) for p in bought_tog],
        }

        batch.append(product)

        # Flush batch to disk
        if len(batch) >= BATCH_SIZE or i == total - 1:
            with open(output_file, 'a', encoding='utf-8') as fh:
                for p in batch:
                    fh.write(orjson.dumps(p).decode('utf-8') + '\n')
            print(f'  [FLUSH] Saved {len(batch)} products → {output_file}')
            batch = []

    print(f'[DONE] {total:,} products written to {output_file}')


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Pikly Hybrid Discovery Engine v2')
    parser.add_argument('--input',  default=None, help='Input JSONL (products_cleaned.jsonl)')
    parser.add_argument('--output', default=None, help='Output JSONL (products_discovery_enhanced.jsonl)')
    return parser.parse_args()


if __name__ == '__main__':
    args        = _parse_args()
    input_file  = resolve_input(args.input)
    output_file = args.output or str(
        Path(input_file).parent / 'products_discovery_enhanced.jsonl'
    )
    process(input_file, output_file)
