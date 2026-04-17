// cmd/server/main.go — Pikly Cache Proxy entrypoint.
//
// Starts a Gin HTTP server that:
//   • Sits between the internet and the NestJS API
//   • Caches GET responses in Redis (circuit-breaker protected)
//   • Exposes /metrics (Prometheus) and /health endpoints
//   • Logs structured JSON via uber/zap
//
// Config (environment variables):
//   PORT           listen port              (default 4000)
//   UPSTREAM_URL   NestJS API URL          (default http://api:3000)
//   REDIS_ADDR     Redis host:port         (default localhost:6379)
//   REDIS_PASSWORD Redis password          (default "")
//   REDIS_DB       Redis database index    (default 0)
//   GIN_MODE       release | debug         (default release)
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/pikly/cache-proxy/internal/cache"
	"github.com/pikly/cache-proxy/internal/middleware"
	"github.com/pikly/cache-proxy/internal/proxy"
)

// ── Config from environment ───────────────────────────────────────────────────

type Config struct {
	Port         string
	UpstreamURL  string
	RedisAddr    string
	RedisPass    string
	RedisDB      int
	GinMode      string
}

func configFromEnv() Config {
	redisDB := 0
	if s := os.Getenv("REDIS_DB"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			redisDB = n
		}
	}
	return Config{
		Port:        getenv("PORT", "4000"),
		UpstreamURL: getenv("UPSTREAM_URL", "http://api:3000"),
		RedisAddr:   getenv("REDIS_ADDR", "localhost:6379"),
		RedisPass:   getenv("REDIS_PASSWORD", ""),
		RedisDB:     redisDB,
		GinMode:     getenv("GIN_MODE", "release"),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── Logger ────────────────────────────────────────────────────────────────────

func newLogger(mode string) *zap.Logger {
	var cfg zap.Config
	if mode == "debug" {
		cfg = zap.NewDevelopmentConfig()
		cfg.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	} else {
		cfg = zap.NewProductionConfig()
	}
	log, err := cfg.Build()
	if err != nil {
		panic(err)
	}
	return log
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	cfg := configFromEnv()
	log := newLogger(cfg.GinMode)
	defer log.Sync() //nolint:errcheck

	log.Info("pikly cache-proxy starting",
		zap.String("port", cfg.Port),
		zap.String("upstream", cfg.UpstreamURL),
		zap.String("redis", cfg.RedisAddr),
	)

	// ── Cache store ──────────────────────────────────────────────────────────
	store := cache.New(
		cfg.RedisAddr,
		cfg.RedisPass,
		cfg.RedisDB,
		cache.DefaultConfig(),
		log,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := store.Ping(ctx); err != nil {
		log.Warn("redis ping failed — starting with cache disabled", zap.Error(err))
	} else {
		log.Info("redis connected")
	}

	// ── Proxy handler ────────────────────────────────────────────────────────
	p, err := proxy.New(cfg.UpstreamURL, store, log)
	if err != nil {
		log.Fatal("invalid upstream URL", zap.Error(err))
	}

	// ── Gin router ───────────────────────────────────────────────────────────
	gin.SetMode(cfg.GinMode)
	r := gin.New()

	// Middleware order matters:
	//   1. RequestID    — stamp every request with a trace ID first so all
	//                     subsequent middleware and handlers can reference it.
	//   2. CORS         — must run before SecurityHeaders so that
	//                     Access-Control-* headers are written before any
	//                     handler (including the cache layer) flushes the
	//                     response. Also short-circuits OPTIONS preflights
	//                     before they reach the proxy or upstream.
	//   3. SecurityHeaders — adds X-Content-Type-Options, X-Frame-Options, etc.
	//   4. Logger       — records the final status code after all handlers run.
	//   5. Metrics      — records Prometheus counters/histograms after handlers.
	r.Use(
		middleware.RequestID(),
		middleware.CORS(log),
		middleware.SecurityHeaders(),
		middleware.Logger(log),
		middleware.Metrics(),
	)

	// Observability endpoints — served from proxy itself, not forwarded
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"service": "cache-proxy",
			"version": "4.0.0",
		})
	})
	r.GET("/metrics", gin.WrapH(promhttp.Handler()))

	// Cache invalidation admin endpoint (internal only — add auth middleware in prod)
	r.DELETE("/cache", func(c *gin.Context) {
		pattern := c.Query("pattern")
		if pattern == "" {
			pattern = "px:*"
		}
		n, err2 := store.Invalidate(c.Request.Context(), pattern)
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err2.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"deleted": n, "pattern": pattern})
	})

	// Everything else → reverse proxy with caching
	r.NoRoute(p.Proxy())

	// ── Graceful shutdown ────────────────────────────────────────────────────
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info("listening", zap.String("addr", srv.Addr))
		if err3 := srv.ListenAndServe(); err3 != nil && !errors.Is(err3, http.ErrServerClosed) {
			log.Fatal("server error", zap.Error(err3))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info("shutting down…")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	if err4 := srv.Shutdown(shutCtx); err4 != nil {
		log.Error("shutdown error", zap.Error(err4))
	}
	log.Info("stopped")
}
