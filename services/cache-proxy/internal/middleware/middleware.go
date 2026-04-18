// internal/middleware/middleware.go — Gin middleware stack.
package middleware

import (
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
)

// ── Prometheus metrics ───────────────────────────────────────────────────────

var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pikly_proxy_requests_total",
		Help: "Total HTTP requests through the cache proxy.",
	}, []string{"method", "path_pattern", "status", "cache"})

	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pikly_proxy_duration_seconds",
		Help:    "Request latency in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "path_pattern", "cache"})

	cacheHitRatio = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pikly_cache_hit_ratio",
		Help: "Rolling cache hit ratio per path pattern.",
	}, []string{"path_pattern"})
)

// RequestID injects a unique X-Request-ID header into every request.
func RequestID() gin.HandlerFunc {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if id == "" {
			b := make([]byte, 12)
			for i := range b {
				b[i] = chars[rand.Intn(len(chars))]
			}
			id = string(b)
		}
		c.Set("requestID", id)
		c.Header("X-Request-ID", id)
		c.Next()
	}
}

// Logger emits a structured access log line after each request.
func Logger(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start  := time.Now()
		path   := c.Request.URL.Path
		query  := c.Request.URL.RawQuery

		c.Next()

		latency    := time.Since(start)
		statusCode := c.Writer.Status()
		cacheHit   := c.GetBool("cacheHit")

		fields := []zap.Field{
			zap.String("method",     c.Request.Method),
			zap.String("path",       path),
			zap.String("query",      query),
			zap.Int("status",        statusCode),
			zap.Duration("latency",  latency),
			zap.Bool("cache_hit",    cacheHit),
			zap.String("ip",         c.ClientIP()),
			zap.String("request_id", c.GetString("requestID")),
		}

		switch {
		case statusCode >= 500:
			log.Error("request", fields...)
		case statusCode >= 400:
			log.Warn("request", fields...)
		default:
			log.Info("request", fields...)
		}
	}
}

// Metrics records Prometheus counters + histograms after each request.
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start   := time.Now()
		pattern := routePattern(c.FullPath())

		c.Next()

		status  := strconv.Itoa(c.Writer.Status())
		cache   := "miss"
		if c.GetBool("cacheHit") {
			cache = "hit"
		}

		httpRequests.WithLabelValues(c.Request.Method, pattern, status, cache).Inc()
		httpDuration.WithLabelValues(c.Request.Method, pattern, cache).
			Observe(time.Since(start).Seconds())
	}
}

// routePattern converts full Gin paths to short labels safe for Prometheus.
func routePattern(full string) string {
	if full == "" {
		return "unknown"
	}
	return full
}

// SecurityHeaders adds opinionated security response headers.
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Header("X-Powered-By", "pikly/4.0")
		c.Next()
	}
}

// Cors handles Cross-Origin Resource Sharing for browser clients.
//
// The proxy is the entry point for all browser requests, so CORS headers
// must be set here — not on the upstream NestJS API (which the proxy calls
// server-to-server, without an Origin header).
//
// Strategy (mirrors the NestJS API policy):
//   • Origins listed in ALLOWED_ORIGINS env var → always allowed (dev + prod)
//   • Any localhost origin → allowed automatically when GIN_MODE != "release"
//   • No Origin header (curl, Postman, server) → pass through unchanged
//   • Everything else → 403 Forbidden
//
// ALLOWED_ORIGINS must be a comma-separated list of full origins:
//   ALLOWED_ORIGINS=http://localhost:3000,https://pikly.com,https://www.pikly.com
func Cors() gin.HandlerFunc {
	isProd := os.Getenv("GIN_MODE") == "release"

	// Parse the whitelist once at startup
	rawOrigins := os.Getenv("ALLOWED_ORIGINS")
	explicitOrigins := map[string]struct{}{}
	for _, o := range strings.Split(rawOrigins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			explicitOrigins[o] = struct{}{}
		}
	}

	// Matches http://localhost, http://localhost:3000, https://localhost:5173, etc.
	localhostRE := regexp.MustCompile(`^https?://localhost(:\d+)?$`)

	const (
		allowedHeaders = "Content-Type,Authorization,X-Session-ID,Idempotency-Key,X-Request-ID"
		allowedMethods = "GET,POST,PATCH,DELETE,OPTIONS"
		exposedHeaders = "X-Total-Count,X-Cache,Age,X-Request-ID"
		maxAge         = "86400" // 24 h — browsers cache preflight, fewer OPTIONS round-trips
	)

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")

		// No Origin header → server-to-server caller → not subject to CORS
		if origin == "" {
			c.Next()
			return
		}

		_, isExplicit := explicitOrigins[origin]
		isLocalhost := !isProd && localhostRE.MatchString(origin)

		if !isExplicit && !isLocalhost {
			// Log the blocked origin so it shows up in Railway logs
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "CORS: origin not permitted — add it to ALLOWED_ORIGINS",
			})
			return
		}

		// Set CORS headers on every response (including cache hits)
		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Allow-Credentials", "true")
		c.Header("Access-Control-Allow-Methods", allowedMethods)
		c.Header("Access-Control-Allow-Headers", allowedHeaders)
		c.Header("Access-Control-Expose-Headers", exposedHeaders)
		c.Header("Access-Control-Max-Age", maxAge)
		// Vary: Origin tells CDNs / browsers to cache responses per origin
		c.Header("Vary", "Origin")

		// OPTIONS preflight — respond immediately, do not forward to upstream
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
