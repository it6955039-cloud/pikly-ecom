// native/ranker/src/addon.cc — Node.js N-API binding for the C++ ranker.
//
// Exposes two async JS functions:
//
//   rankProducts(products: ProductRecord[], opts?: RankOptions): Promise<RankedProduct[]>
//   priceSort(products: ProductRecord[], direction: 1|-1, limit: number): Promise<RankedProduct[]>
//
// Both run in a libuv thread pool worker so they never block the Node.js
// event loop — even ranking 10,000 products takes <1 ms in C++.
#include <napi.h>
#include "ranker.h"

#include <cmath>
#include <string>
#include <vector>

namespace pikly_addon {

// ── JS → C++ conversion helpers ───────────────────────────────────────────────

static pikly::ProductRecord record_from_js(const Napi::Object& obj) {
    pikly::ProductRecord r;
    auto get_str  = [&](const char* k) -> std::string {
        auto v = obj.Get(k);
        return v.IsString() ? v.As<Napi::String>().Utf8Value() : "";
    };
    auto get_dbl  = [&](const char* k, double d = 0.0) -> double {
        auto v = obj.Get(k);
        return v.IsNumber() ? v.As<Napi::Number>().DoubleValue() : d;
    };
    auto get_int  = [&](const char* k, int32_t d = 0) -> int32_t {
        auto v = obj.Get(k);
        return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : d;
    };
    auto get_bool = [&](const char* k, bool d = false) -> bool {
        auto v = obj.Get(k);
        return v.IsBoolean() ? v.As<Napi::Boolean>().Value() : d;
    };

    r.asin              = get_str("asin");
    r.slug              = get_str("slug");
    r.price             = get_dbl("price");
    r.avg_rating        = get_dbl("avg_rating");
    r.review_count      = get_int("review_count");
    r.discount_pct      = get_int("discount_pct");
    r.is_prime          = get_bool("is_prime");
    r.is_best_seller    = get_bool("is_best_seller");
    r.is_trending       = get_bool("is_trending");
    r.in_stock          = get_bool("in_stock", true);
    r.is_on_sale        = get_bool("is_on_sale");

    // bought_last_month is a string like "10K+" — parse numeric prefix
    std::string blm = get_str("bought_last_month");
    if (!blm.empty()) {
        try {
            double multiplier = 1.0;
            if (!blm.empty() && (blm.back() == 'K' || blm.back() == 'k')) {
                multiplier = 1000.0;
                blm.pop_back();
            } else if (!blm.empty() && blm.back() == '+') {
                blm.pop_back();
            }
            r.bought_last_month_n = std::stod(blm) * multiplier;
        } catch (...) {
            r.bought_last_month_n = 0.0;
        }
    }
    return r;
}

static pikly::RankWeights weights_from_js(const Napi::Object& opts) {
    pikly::RankWeights w;
    auto get = [&](const char* k, double d) -> double {
        auto v = opts.Get(k);
        return v.IsNumber() ? v.As<Napi::Number>().DoubleValue() : d;
    };
    w.w_rating      = get("wRating",     w.w_rating);
    w.w_review_log  = get("wReviewLog",  w.w_review_log);
    w.w_prime       = get("wPrime",      w.w_prime);
    w.w_best_seller = get("wBestSeller", w.w_best_seller);
    w.w_trending    = get("wTrending",   w.w_trending);
    w.w_in_stock    = get("wInStock",    w.w_in_stock);
    w.w_discount    = get("wDiscount",   w.w_discount);
    w.w_bought      = get("wBought",     w.w_bought);
    return w;
}

// ── Async worker: rankProducts ────────────────────────────────────────────────

class RankWorker : public Napi::AsyncWorker {
public:
    RankWorker(
        Napi::Promise::Deferred  deferred,
        std::vector<pikly::ProductRecord> products,
        pikly::RankWeights       weights,
        std::size_t              limit
    )
        : Napi::AsyncWorker(deferred.Env())
        , deferred_(deferred)
        , products_(std::move(products))
        , weights_(weights)
        , limit_(limit)
    {}

    void Execute() override {
        results_ = pikly::rank(products_, weights_, limit_);
    }

    void OnOK() override {
        Napi::Env env = Env();
        auto arr = Napi::Array::New(env, results_.size());
        for (std::size_t i = 0; i < results_.size(); ++i) {
            auto obj = Napi::Object::New(env);
            obj.Set("asin",  Napi::String::New(env, results_[i].asin));
            obj.Set("slug",  Napi::String::New(env, results_[i].slug));
            obj.Set("score", Napi::Number::New(env, results_[i].score));
            arr.Set(static_cast<uint32_t>(i), obj);
        }
        deferred_.Resolve(arr);
    }

    void OnError(const Napi::Error& e) override {
        deferred_.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred         deferred_;
    std::vector<pikly::ProductRecord> products_;
    pikly::RankWeights              weights_;
    std::size_t                     limit_;
    std::vector<pikly::RankedProduct> results_;
};

// ── JS binding: rankProducts ─────────────────────────────────────────────────

Napi::Value RankProducts(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred  = Napi::Promise::Deferred::New(env);

    if (info.Length() < 1 || !info[0].IsArray()) {
        deferred.Reject(Napi::TypeError::New(env, "Argument 0 must be an array").Value());
        return deferred.Promise();
    }

    auto jsArr   = info[0].As<Napi::Array>();
    std::vector<pikly::ProductRecord> products;
    products.reserve(jsArr.Length());
    for (uint32_t i = 0; i < jsArr.Length(); ++i) {
        products.push_back(record_from_js(jsArr.Get(i).As<Napi::Object>()));
    }

    pikly::RankWeights weights;
    if (info.Length() >= 2 && info[1].IsObject()) {
        weights = weights_from_js(info[1].As<Napi::Object>());
    }

    std::size_t limit = products.size();
    if (info.Length() >= 3 && info[2].IsNumber()) {
        limit = static_cast<std::size_t>(info[2].As<Napi::Number>().Int32Value());
    }

    auto* worker = new RankWorker(deferred, std::move(products), weights, limit);
    worker->Queue();
    return deferred.Promise();
}

// ── Async worker: priceSort ───────────────────────────────────────────────────

class PriceSortWorker : public Napi::AsyncWorker {
public:
    PriceSortWorker(
        Napi::Promise::Deferred  deferred,
        std::vector<pikly::ProductRecord> products,
        int                      direction,
        std::size_t              limit
    )
        : Napi::AsyncWorker(deferred.Env())
        , deferred_(deferred)
        , products_(std::move(products))
        , direction_(direction)
        , limit_(limit)
    {}

    void Execute() override {
        results_ = pikly::price_sort(products_, direction_, limit_);
    }

    void OnOK() override {
        Napi::Env env = Env();
        auto arr = Napi::Array::New(env, results_.size());
        for (std::size_t i = 0; i < results_.size(); ++i) {
            auto obj = Napi::Object::New(env);
            obj.Set("asin",  Napi::String::New(env, results_[i].asin));
            obj.Set("slug",  Napi::String::New(env, results_[i].slug));
            obj.Set("score", Napi::Number::New(env, results_[i].score));
            arr.Set(static_cast<uint32_t>(i), obj);
        }
        deferred_.Resolve(arr);
    }

    void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
    Napi::Promise::Deferred           deferred_;
    std::vector<pikly::ProductRecord> products_;
    int                               direction_;
    std::size_t                       limit_;
    std::vector<pikly::RankedProduct> results_;
};

Napi::Value PriceSort(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred  = Napi::Promise::Deferred::New(env);

    if (info.Length() < 1 || !info[0].IsArray()) {
        deferred.Reject(Napi::TypeError::New(env, "Argument 0 must be an array").Value());
        return deferred.Promise();
    }

    auto jsArr = info[0].As<Napi::Array>();
    std::vector<pikly::ProductRecord> products;
    products.reserve(jsArr.Length());
    for (uint32_t i = 0; i < jsArr.Length(); ++i) {
        products.push_back(record_from_js(jsArr.Get(i).As<Napi::Object>()));
    }

    int dir = (info.Length() >= 2 && info[1].IsNumber())
        ? info[1].As<Napi::Number>().Int32Value() : 1;
    std::size_t limit = (info.Length() >= 3 && info[2].IsNumber())
        ? static_cast<std::size_t>(info[2].As<Napi::Number>().Int32Value())
        : products.size();

    auto* worker = new PriceSortWorker(deferred, std::move(products), dir, limit);
    worker->Queue();
    return deferred.Promise();
}

// ── Module init ───────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("rankProducts", Napi::Function::New(env, RankProducts));
    exports.Set("priceSort",    Napi::Function::New(env, PriceSort));
    return exports;
}

NODE_API_MODULE(pikly_ranker, Init)

} // namespace pikly_addon
