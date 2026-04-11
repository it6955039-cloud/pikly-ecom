// internal/middleware/middleware.go — Gin middleware stack.
package middleware

import (
	"math/rand"
	"strconv"
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
