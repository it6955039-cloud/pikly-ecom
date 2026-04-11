// native/ranker/src/ranker.cc — Product ranking engine implementation.
#include "ranker.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace pikly {

// ── Utility: normalise a value in [0, max] → [0, 1] ──────────────────────────
static inline double norm(double v, double max_v) noexcept {
    if (max_v <= 0.0) return 0.0;
    return std::max(0.0, std::min(1.0, v / max_v));
}

// ── rank() ────────────────────────────────────────────────────────────────────

std::vector<RankedProduct> rank(
    const std::vector<ProductRecord>& products,
    const RankWeights&                w,
    std::size_t                       limit
) {
    if (products.empty()) return {};

    // ── Pre-compute normalisation denominators in a single pass ──────────────
    double max_reviews = 0.0;
    double max_bought  = 0.0;

    for (const auto& p : products) {
        if (p.review_count > max_reviews) max_reviews = static_cast<double>(p.review_count);
        if (p.bought_last_month_n > max_bought) max_bought = p.bought_last_month_n;
    }

    const double log_max_reviews = (max_reviews > 0)
        ? std::log10(max_reviews + 1.0) : 1.0;

    // ── Score every product ───────────────────────────────────────────────────
    std::vector<RankedProduct> results;
    results.reserve(products.size());

    for (const auto& p : products) {
        double score = 0.0;

        // Rating component: (rating/5) weighted by log-normalised review count
        const double rating_n  = norm(p.avg_rating, 5.0);
        const double review_n  = (log_max_reviews > 0)
            ? std::log10(static_cast<double>(p.review_count) + 1.0) / log_max_reviews
            : 0.0;

        // Blend rating × review confidence — no review → rating worth less
        score += w.w_rating     * rating_n * (0.5 + 0.5 * review_n);
        score += w.w_review_log * review_n;

        // Binary signals
        score += w.w_prime       * (p.is_prime       ? 1.0 : 0.0);
        score += w.w_best_seller * (p.is_best_seller  ? 1.0 : 0.0);
        score += w.w_trending    * (p.is_trending     ? 1.0 : 0.0);
        score += w.w_in_stock    * (p.in_stock        ? 1.0 : 0.0);

        // Discount (0–100 → 0–1)
        score += w.w_discount * norm(static_cast<double>(p.discount_pct), 100.0);

        // Bought-last-month (optional — sparse data)
        if (max_bought > 0.0 && w.w_bought > 0.0) {
            score += w.w_bought * norm(p.bought_last_month_n, max_bought);
        }

        results.push_back({ p.asin, p.slug, score });
    }

    // ── Partial sort — only top `limit` need to be in order ──────────────────
    const std::size_t n = std::min(limit, results.size());
    std::partial_sort(
        results.begin(),
        results.begin() + static_cast<std::ptrdiff_t>(n),
        results.end(),
        [](const RankedProduct& a, const RankedProduct& b) noexcept {
            return a.score > b.score; // descending
        }
    );
    results.resize(n);
    return results;
}

// ── price_sort() ──────────────────────────────────────────────────────────────

std::vector<RankedProduct> price_sort(
    const std::vector<ProductRecord>& products,
    int                               direction,
    std::size_t                       limit
) {
    if (products.empty()) return {};

    // Build index array to avoid copying records
    std::vector<std::size_t> idx(products.size());
    std::iota(idx.begin(), idx.end(), 0);

    std::sort(idx.begin(), idx.end(), [&](std::size_t a, std::size_t b) noexcept {
        const auto& pa = products[a];
        const auto& pb = products[b];
        // Always put in-stock items before out-of-stock at the same price band
        if (pa.in_stock != pb.in_stock) return pa.in_stock > pb.in_stock;
        if (direction >= 0) return pa.price < pb.price;
        return pa.price > pb.price;
    });

    const std::size_t n = std::min(limit, idx.size());
    std::vector<RankedProduct> results;
    results.reserve(n);

    for (std::size_t i = 0; i < n; ++i) {
        const auto& p = products[idx[i]];
        // Use price as the "score" for transparency
        results.push_back({ p.asin, p.slug, p.price });
    }
    return results;
}

} // namespace pikly
