// internal/proxy/proxy.go — Caching reverse proxy handler.
//
// Flow for a GET request:
//   1. Build cache key from method + path + sorted query string
//   2. Admin paths (/api/admin/*) → always bypass cache, forward directly
//   3. Check Redis — return cached response if hit (sets X-Cache: HIT)
//   4. On miss: forward to upstream NestJS API
//   5. If upstream responds 2xx: store body in Redis with path-aware TTL
//   6. Always set X-Cache: MISS on first serve
//
// Non-GET requests (POST, PATCH, DELETE) are always forwarded to upstream.
// Mutation routes also trigger cache invalidation (pattern-based).
//
// Admin mutation rule: any write to /api/admin/<resource> invalidates the
// corresponding public GET cache so the storefront sees fresh data immediately.
package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/pikly/cache-proxy/internal/cache"
)

// Handler wraps the cache store and upstream URL.
type Handler struct {
	upstream *url.URL
	store    *cache.Store
	log      *zap.Logger
	client   *http.Client
}

// New creates a caching proxy pointing at upstreamURL (e.g. "http://api:3000").
func New(upstreamURL string, store *cache.Store, log *zap.Logger) (*Handler, error) {
	u, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream URL %q: %w", upstreamURL, err)
	}
	return &Handler{
		upstream: u,
		store:    store,
		log:      log,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}, nil
}

// ── Cache key ─────────────────────────────────────────────────────────────────

func cacheKey(method, path, rawQuery string) string {
	if rawQuery == "" {
		return fmt.Sprintf("px:%s:%s", method, path)
	}
	q, _ := url.ParseQuery(rawQuery)
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+strings.Join(q[k], ","))
	}
	return fmt.Sprintf("px:%s:%s:%s", method, path, strings.Join(parts, "&"))
}

// ── Invalidation rules ────────────────────────────────────────────────────────
//
// invalidationPatterns returns all Redis glob patterns to delete after a
// successful mutation on the given path.
//
// KEY FIX: Admin mutations (/api/admin/products, /api/admin/banners, etc.)
// must invalidate the corresponding PUBLIC cache keys, because the storefront
// reads from /api/products, /api/banners, etc. — not the admin endpoints.
//
// Before this fix: admin writes had no matching case → no cache invalidation
// → storefront served stale data until Redis TTL expired (up to 15 minutes).
func invalidationPatterns(path string) []string {
	switch {

	// ── Public product mutations ─────────────────────────────────────────
	case strings.HasPrefix(path, "/api/products"):
		return []string{"px:GET:/api/products*"}

	// ── Admin product mutations → invalidate public product cache ────────
	// Covers: toggle, update, delete, create, bulk ops on products.
	case strings.HasPrefix(path, "/api/admin/products"),
		strings.HasPrefix(path, "/api/admin/bulk"):
		return []string{
			"px:GET:/api/products*",     // storefront list + search
			"px:GET:/api/homepage*",     // homepage widgets may show products
		}

	// ── Admin banner mutations → invalidate public banner cache ─────────
	case strings.HasPrefix(path, "/api/admin/banners"):
		return []string{
			"px:GET:/api/banners*",
			"px:GET:/api/homepage*",
		}

	// ── Admin category mutations → invalidate public category cache ──────
	case strings.HasPrefix(path, "/api/admin/categories"):
		return []string{
			"px:GET:/api/categories*",
			"px:GET:/api/homepage*",
		}

	// ── Admin homepage widget mutations ──────────────────────────────────
	case strings.HasPrefix(path, "/api/admin/homepage-widgets"):
		return []string{
			"px:GET:/api/homepage*",
		}

	// ── Admin coupon mutations ────────────────────────────────────────────
	// Coupons are validated at checkout — not cached at proxy level,
	// but clear the pattern as a safety net.
	case strings.HasPrefix(path, "/api/admin/coupons"):
		return []string{
			"px:GET:/api/coupons*",
		}

	// ── Admin user mutations ──────────────────────────────────────────────
	// User endpoints are personal data — never cached at proxy level
	// (noCachePath covers /api/users/*). No public invalidation needed.
	case strings.HasPrefix(path, "/api/admin/users"):
		return nil

	// ── Admin order mutations ─────────────────────────────────────────────
	// Orders are per-user — never cached at proxy level. No invalidation.
	case strings.HasPrefix(path, "/api/admin/orders"):
		return nil

	// ── Public homepage / category mutations ─────────────────────────────
	case strings.HasPrefix(path, "/api/homepage"):
		return []string{"px:GET:/api/homepage*"}

	case strings.HasPrefix(path, "/api/categories"):
		return []string{"px:GET:/api/categories*"}

	// ── Cart and orders (safety net — these bypass cache anyway) ─────────
	case strings.HasPrefix(path, "/api/cart"):
		return []string{"px:GET:/api/cart*"}

	case strings.HasPrefix(path, "/api/orders"):
		return []string{"px:GET:/api/orders*"}

	default:
		return nil
	}
}

// ── Gin handler ───────────────────────────────────────────────────────────────

func (h *Handler) Proxy() gin.HandlerFunc {
	return func(c *gin.Context) {
		path  := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		if c.Request.Method == http.MethodGet ||
			c.Request.Method == http.MethodHead {
			h.serveWithCache(c, path, query)
			return
		}

		// ── Write path: forward → invalidate on success ───────────────────
		h.forward(c)

		if c.Writer.Status() < 300 {
			for _, pat := range invalidationPatterns(path) {
				n, err := h.store.Invalidate(c.Request.Context(), pat)
				if err == nil {
					h.log.Info("cache invalidated",
						zap.String("pattern", pat),
						zap.Int64("keys_deleted", n),
						zap.String("triggered_by", path),
					)
				} else {
					h.log.Warn("cache invalidation failed",
						zap.String("pattern", pat),
						zap.Error(err),
					)
				}
			}
		}
	}
}

// ── Read path ─────────────────────────────────────────────────────────────────

// noCachePath returns true for paths that must never be served from cache.
//
// FIX: Added /api/admin/* — admin GETs must always be fresh from the DB.
// Before this fix, admin list responses were cached in Redis; after a toggle
// or delete the admin panel itself showed stale data until TTL expired.
//
// Also added /api/users/* — user-specific data (profile, orders, cart)
// must never be cached at proxy level to prevent cross-user data leaks.
func noCachePath(path string) bool {
	return path == "/api/docs" ||
		strings.HasPrefix(path, "/api/docs/") ||
		path == "/api/docs-json" ||
		path == "/api/docs-yaml" ||
		path == "/health" ||
		strings.HasPrefix(path, "/health") ||
		// ── FIX: Admin endpoints must never be cached ────────────────────
		// Admin GETs must reflect DB state instantly after mutations.
		strings.HasPrefix(path, "/api/admin") ||
		// ── User-specific data — security: never cache across users ──────
		strings.HasPrefix(path, "/api/users") ||
		strings.HasPrefix(path, "/api/cart") ||
		strings.HasPrefix(path, "/api/orders")
}

func (h *Handler) serveWithCache(c *gin.Context, path, query string) {
	if noCachePath(path) {
		h.forward(c)
		return
	}

	key := cacheKey(c.Request.Method, path, query)

	if hit := h.store.Get(c.Request.Context(), key); hit != nil {
		c.Set("cacheHit", true)
		for k, v := range hit.Headers {
			c.Header(k, v)
		}
		age := int(time.Since(time.UnixMilli(hit.CachedAt)).Seconds())
		c.Header("X-Cache", "HIT")
		c.Header("Age", fmt.Sprintf("%d", age))
		c.Data(hit.Status, hit.Headers["Content-Type"], hit.Body)
		return
	}

	resp, body, err := h.doUpstream(c)
	if err != nil {
		h.log.Error("upstream request failed", zap.String("path", path), zap.Error(err))
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream unavailable"})
		return
	}
	defer resp.Body.Close()

	cachedHeaders := map[string]string{}
	for _, name := range []string{
		"Content-Type", "Content-Language", "Cache-Control",
		"ETag", "Last-Modified", "Vary",
	} {
		if v := resp.Header.Get(name); v != "" {
			cachedHeaders[name] = v
		}
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		ttl := h.store.TTLFor(path)
		if ttl > 0 {
			h.store.Set(c.Request.Context(), key, &cache.CachedResponse{
				Status:   resp.StatusCode,
				Headers:  cachedHeaders,
				Body:     body,
				CachedAt: time.Now().UnixMilli(),
			}, ttl)
		}
	}

	c.Set("cacheHit", false)
	for k, v := range cachedHeaders {
		c.Header(k, v)
	}
	c.Header("X-Cache", "MISS")
	c.Data(resp.StatusCode, cachedHeaders["Content-Type"], body)
}

// ── Upstream call ─────────────────────────────────────────────────────────────

func (h *Handler) doUpstream(c *gin.Context) (*http.Response, []byte, error) {
	targetURL := *h.upstream
	targetURL.Path     = c.Request.URL.Path
	targetURL.RawQuery = c.Request.URL.RawQuery

	req, err := http.NewRequestWithContext(
		c.Request.Context(),
		c.Request.Method,
		targetURL.String(),
		c.Request.Body,
	)
	if err != nil {
		return nil, nil, err
	}

	for _, h2 := range []string{
		"Authorization", "Accept", "Accept-Language",
		"Content-Type", "X-Request-ID",
	} {
		if v := c.Request.Header.Get(h2); v != "" {
			req.Header.Set(h2, v)
		}
	}
	req.Header.Set("X-Forwarded-For", c.ClientIP())
	req.Header.Set("X-Forwarded-Proto", "https")

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, nil, err
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, body, err
}

func (h *Handler) forward(c *gin.Context) {
	resp, body, err := h.doUpstream(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream unavailable"})
		return
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		for _, v := range vs {
			c.Header(k, v)
		}
	}
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), body)
}
