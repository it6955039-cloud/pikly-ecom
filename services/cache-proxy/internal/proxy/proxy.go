// internal/proxy/proxy.go — Caching reverse proxy handler.
//
// Flow for a GET request:
//   1. Build cache key from method + path + sorted query string
//   2. Check Redis — return cached response if hit (sets X-Cache: HIT)
//   3. On miss: forward to upstream NestJS API
//   4. If upstream responds 2xx: store body in Redis with path-aware TTL
//   5. Always set X-Cache: MISS on first serve
//
// Non-GET requests (POST, PATCH, DELETE) are always forwarded to upstream.
// Mutation routes also trigger cache invalidation (pattern-based).
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

// ── Cache key ────────────────────────────────────────────────────────────────

// cacheKey builds a stable, sorted key from method + path + query.
func cacheKey(method, path, rawQuery string) string {
	if rawQuery == "" {
		return fmt.Sprintf("px:%s:%s", method, path)
	}
	// Sort query params for key stability (e.g. ?b=1&a=2 == ?a=2&b=1)
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

// ── Invalidation rules ───────────────────────────────────────────────────────

// invalidationPattern returns a Redis glob for routes that mutate products.
func invalidationPattern(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/products"):
		return "px:GET:/api/products*"
	case strings.HasPrefix(path, "/api/homepage"):
		return "px:GET:/api/homepage*"
	case strings.HasPrefix(path, "/api/categories"):
		return "px:GET:/api/categories*"
	default:
		return ""
	}
}

// ── Gin handler ──────────────────────────────────────────────────────────────

// Proxy returns the main Gin handler. Mount on "/*path" to catch everything.
func (h *Handler) Proxy() gin.HandlerFunc {
	return func(c *gin.Context) {
		path  := c.Request.URL.Path
		query := c.Request.URL.RawQuery

		// ── Only cache safe read methods ─────────────────────────────────────
		if c.Request.Method == http.MethodGet ||
			c.Request.Method == http.MethodHead {
			h.serveWithCache(c, path, query)
			return
		}

		// ── Write path: forward + invalidate ─────────────────────────────────
		h.forward(c)

		if c.Writer.Status() < 300 {
			if pat := invalidationPattern(path); pat != "" {
				n, err := h.store.Invalidate(c.Request.Context(), pat)
				if err == nil {
					h.log.Info("cache invalidated",
						zap.String("pattern", pat),
						zap.Int64("keys_deleted", n))
				}
			}
		}
	}
}

// ── Read path ────────────────────────────────────────────────────────────────

// noCachePath returns true for paths that must never be served from cache.
// API documentation reflects live code and must always be fresh.
func noCachePath(path string) bool {
	return path == "/api/docs" ||
		strings.HasPrefix(path, "/api/docs/") ||
		path == "/health" ||
		strings.HasPrefix(path, "/health")
}

func (h *Handler) serveWithCache(c *gin.Context, path, query string) {
	// Bypass cache entirely for docs and health — always proxy through to upstream.
	if noCachePath(path) {
		h.forward(c)
		return
	}

	key := cacheKey(c.Request.Method, path, query)

	if hit := h.store.Get(c.Request.Context(), key); hit != nil {
		// ── Cache HIT ─────────────────────────────────────────────────────
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

	// ── Cache MISS — forward to upstream ─────────────────────────────────
	resp, body, err := h.doUpstream(c)
	if err != nil {
		h.log.Error("upstream request failed", zap.String("path", path), zap.Error(err))
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream unavailable"})
		return
	}
	defer resp.Body.Close()

	// Collect headers to cache (skip hop-by-hop)
	cachedHeaders := map[string]string{}
	for _, name := range []string{
		"Content-Type", "Content-Language", "Cache-Control",
		"ETag", "Last-Modified", "Vary",
	} {
		if v := resp.Header.Get(name); v != "" {
			cachedHeaders[name] = v
		}
	}

	// Only cache successful responses
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		ttl := h.store.TTLFor(path)
		h.store.Set(c.Request.Context(), key, &cache.CachedResponse{
			Status:   resp.StatusCode,
			Headers:  cachedHeaders,
			Body:     body,
			CachedAt: time.Now().UnixMilli(),
		}, ttl)
	}

	// Write response to client
	c.Set("cacheHit", false)
	for k, v := range cachedHeaders {
		c.Header(k, v)
	}
	c.Header("X-Cache", "MISS")
	c.Data(resp.StatusCode, cachedHeaders["Content-Type"], body)
}

// ── Upstream call ────────────────────────────────────────────────────────────

func (h *Handler) doUpstream(c *gin.Context) (*http.Response, []byte, error) {
	targetURL := *h.upstream
	targetURL.Path    = c.Request.URL.Path
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

	// Forward safe headers
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

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20)) // 8 MB cap
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, body, err
}

// forward proxies a request without caching (used for write methods).
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
