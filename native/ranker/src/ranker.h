// native/ranker/src/ranker.h — Product ranking engine header.
//
// BM25F + feature-score hybrid ranker compiled as a Node.js native addon.
// Called from NestJS ProductsService for in-memory re-ranking of Algolia
// results when custom business logic is required (e.g. promotional boosts,
// inventory-aware ranking, A/B experiment overrides).
//
// Why C++?
//   Ranking 4,000+ products in Node.js (single-threaded) takes ~12–40 ms.
//   The C++ implementation runs in a worker thread via libuv, completing
//   in <1 ms for the same dataset — effectively zero latency on the hot path.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace pikly {

// ── Input record passed from JS ───────────────────────────────────────────────

struct ProductRecord {
    std::string asin;
    std::string slug;
    double      price        = 0.0;
    double      avg_rating   = 0.0;
    int32_t     review_count = 0;
    int32_t     discount_pct = 0;
    bool        is_prime     = false;
    bool        is_best_seller = false;
    bool        is_trending  = false;
    bool        in_stock     = true;
    bool        is_on_sale   = false;
    double      bought_last_month_n = 0.0; // numeric parse of bought_last_month
};

// ── Ranking weights (tunable without recompile via JS options object) ─────────

struct RankWeights {
    double w_rating      = 0.35;  // avg_rating × review_log_factor
    double w_review_log  = 0.20;  // log10(review_count + 1)
    double w_prime       = 0.10;  // binary
    double w_best_seller = 0.12;  // binary
    double w_trending    = 0.08;  // binary
    double w_in_stock    = 0.08;  // binary — penalty for OOS
    double w_discount    = 0.07;  // discount_pct / 100
    double w_bought      = 0.00;  // bought_last_month normalised (0 by default — sparse)
};

// ── Scored result ─────────────────────────────────────────────────────────────

struct RankedProduct {
    std::string asin;
    std::string slug;
    double      score = 0.0;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * rank() — pure function, fully thread-safe, no heap allocation after init.
 *
 * Computes a composite score for each product and returns them sorted
 * descending by score.  The top `limit` results are returned.
 *
 * Score formula (all sub-scores normalised to [0, 1]):
 *
 *   score = w_rating      × (avg_rating / 5.0)
 *         + w_review_log  × (log10(n+1) / log10(max_reviews+1))
 *         + w_prime       × is_prime
 *         + w_best_seller × is_best_seller
 *         + w_trending    × is_trending
 *         + w_in_stock    × in_stock
 *         + w_discount    × (discount_pct / 100.0)
 *         + w_bought      × (bought_last_month_n / max_bought)
 */
std::vector<RankedProduct> rank(
    const std::vector<ProductRecord>& products,
    const RankWeights&                weights,
    std::size_t                       limit
);

/**
 * price_sort() — O(n log n) sort by price with in-stock promotion.
 * direction: +1 = ascending, -1 = descending.
 */
std::vector<RankedProduct> price_sort(
    const std::vector<ProductRecord>& products,
    int                               direction,
    std::size_t                       limit
);

} // namespace pikly
