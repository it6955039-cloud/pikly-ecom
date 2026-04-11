"""
pipeline/validate.py — Pydantic v2 models for products_cleaned.jsonl records.
Each incoming record is validated here before being handed to transform.py.
Invalid records are quarantined (logged + skipped) — never crash the pipeline.

Dataset: pikly (replaces oxylabs)
Schema version: v5.0.0 — 2026-04
Changes vs v4:
  • source default changed 'oxylabs' → 'pikly'
  • EnrichedProduct gains enrichment_source_data (top-level field)
  • _dummy_fields removed from new dataset — kept as optional for back-compat
  • DataBlob: search_metadata / search_parameters captured via extra='allow'
  • ProductResults: highResolutionImages / manufacturerContent / manufacturerImages
    captured via extra='allow' — no explicit fields needed
"""
from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field, field_validator, model_validator


class ProductResults(BaseModel):
    """Core scraper payload — only required fields enforced, rest passed through."""
    asin:                str  = ''
    title:               str  = ''
    brand:               str  = ''
    thumbnail:           str  = ''
    thumbnails:          list[str] = Field(default_factory=list)
    rating:              float = 0.0
    reviews:             int   = 0
    extracted_price:     float = 0.0
    extracted_old_price: float | None = None
    prime:               bool  = False
    stock:               str   = ''
    badges:              list[str] = Field(default_factory=list)
    variants:            list[dict[str, Any]] = Field(default_factory=list)
    delivery:            list[str] = Field(default_factory=list)

    # ── pikly-specific fields (captured here for type-safety; engine also
    #    uses them.  All three are TEXT[] / JSONB in the DB via migration 004)
    # highResolutionImages, manufacturerContent, manufacturerImages are passed
    # through via extra='allow' — no explicit fields needed.

    @field_validator('rating', mode='before')
    @classmethod
    def clamp_rating(cls, v: Any) -> float:
        try:
            f = float(v or 0)
            return max(0.0, min(5.0, f))
        except (TypeError, ValueError):
            return 0.0

    @field_validator('extracted_price', 'extracted_old_price', mode='before')
    @classmethod
    def coerce_price(cls, v: Any) -> float | None:
        if v is None:
            return None
        try:
            return max(0.0, float(v))
        except (TypeError, ValueError):
            return None

    model_config = {'extra': 'allow', 'populate_by_name': True}


class Taxonomy(BaseModel):
    department:  str = ''
    subcategory: str = ''


class Flags(BaseModel):
    isBestSeller:    bool = False
    isAmazonsChoice: bool = False
    isTrending:      bool = False
    isHighlyPopular: bool = False
    isNewRelease:    bool = False
    isFreeShipping:  bool = False
    isPrime:         bool = False
    isOnSale:        bool = False
    isDeal:          bool = False
    isTopRated:      bool = False
    inStock:         bool = True

    model_config = {'extra': 'allow'}


class DataBlob(BaseModel):
    """
    The 'data' envelope from the pikly JSONL record.

    pikly wraps search_metadata and search_parameters INSIDE this envelope.
    They are not declared as explicit fields here because their schema differs
    between sources; they are captured by extra='allow' and accessed via
    model_extra in transform.py.
    """
    product_results:     dict[str, Any] = Field(default_factory=dict)
    purchase_options:    dict[str, Any] = Field(default_factory=dict)
    protection_plan:     list[Any]      = Field(default_factory=list)
    item_specifications: dict[str, Any] = Field(default_factory=dict)
    about_item:          list[Any]      = Field(default_factory=list)
    # bought_together / related_products from scraper are intentionally
    # preserved here for audit purposes but OVERRIDDEN by the Discovery Engine
    # output at ingest time (transform.py reads engine output from model_extra).
    bought_together:     list[Any]      = Field(default_factory=list)
    related_products:    list[Any]      = Field(default_factory=list)
    sponsored_brands:    list[Any]      = Field(default_factory=list)
    videos:              list[Any]      = Field(default_factory=list)
    product_description: list[Any]      = Field(default_factory=list)
    product_details:     dict[str, Any] = Field(default_factory=dict)
    reviews_information: dict[str, Any] = Field(default_factory=dict)
    category:            list[Any]      = Field(default_factory=list)
    accordionContent:    list[Any]      = Field(default_factory=list)
    shippingFees:        dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode='before')
    @classmethod
    def drop_none_values(cls, data: Any) -> Any:
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if v is not None}
        return data

    model_config = {'extra': 'allow'}


class EnrichedProduct(BaseModel):
    """
    Top-level record from products_cleaned.jsonl (pikly source).

    After hybrid_discovery_engine.py runs, the output JSONL contains an
    additional top-level key:
        related_products: { similar: [...], bought_together: [...] }
    This is captured via extra='allow' and accessed in transform.py via
    model_extra to replace the scraper's bt/rp with engine recommendations.
    """
    asin:   str
    source: str      = 'pikly'          # ← changed from 'oxylabs'
    data:   DataBlob = Field(default_factory=DataBlob)

    # taxonomy / flags use alias to accept underscore-prefixed keys from JSONL
    taxonomy:     Taxonomy  = Field(default_factory=Taxonomy, alias='_taxonomy')
    flags:        Flags     = Field(default_factory=Flags,    alias='_flags')

    # dummy_fields: present in old oxylabs dataset, absent in pikly.
    # Kept optional so the model accepts both formats without quarantining.
    dummy_fields: list[Any] = Field(default_factory=list, alias='_dummy_fields')

    # enrichment_source_data: new pikly top-level field containing additional
    # scraper context (asinVariationValues, highResolutionImages, reviews, etc.)
    enrichment_source_data: dict[str, Any] = Field(default_factory=dict)

    @field_validator('asin')
    @classmethod
    def asin_nonempty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('asin must be non-empty')
        return v.strip().upper()

    model_config = {'extra': 'allow', 'populate_by_name': True}
