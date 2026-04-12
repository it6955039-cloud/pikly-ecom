// internal/cache/cache.go — Redis-backed response cache with circuit breaker.
//
// Pattern: read-through cache that sits in front of the NestJS API.
// Circuit breaker prevents Redis failures from cascading into API downtime —
// on open circuit the proxy passes requests through with no caching.
package cache

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Config holds cache and circuit-breaker tuning parameters.
type Config struct {
	DefaultTTL  time.Duration // generic routes
	ProductTTL  time.Duration // GET /api/products/:slug — changes rarely
	ListTTL     time.Duration // GET /api/products?*     — more volatile
	MaxFailures int32         // consecutive Redis errors to open circuit
	ResetAfter  time.Duration // time before half-open probe
}

func DefaultConfig() Config {
	return Config{
		DefaultTTL:  5 * time.Minute,
		ProductTTL:  15 * time.Minute,
		ListTTL:     2 * time.Minute,
		MaxFailures: 5,
		ResetAfter:  30 * time.Second,
	}
}

// CachedResponse is the envelope stored in Redis.
type CachedResponse struct {
	Status  int               `json:"s"`
	Headers map[string]string `json:"h"`
	Body    []byte            `json:"b"`
	CachedAt int64            `json:"t"` // unix millis — for Age header
}

func (r *CachedResponse) MarshalBinary() ([]byte, error)    { return json.Marshal(r) }
func (r *CachedResponse) UnmarshalBinary(d []byte) error { return json.Unmarshal(d, r) }

// Store is the thread-safe cache backed by Redis.
type Store struct {
	rdb      *redis.Client
	cfg      Config
	log      *zap.Logger
	failures atomic.Int32
	openedAt atomic.Int64 // unix-nano when circuit opened; 0 = closed
}

func New(addr, password string, db int, cfg Config, log *zap.Logger) *Store {
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		TLSConfig:    &tls.Config{},
		DialTimeout:  2 * time.Second,
		ReadTimeout:  1 * time.Second,
		WriteTimeout: 1 * time.Second,
		PoolSize:     20,
		MinIdleConns: 5,
	})
	return &Store{rdb: rdb, cfg: cfg, log: log}
}

func (s *Store) Ping(ctx context.Context) error { return s.rdb.Ping(ctx).Err() }

// ── Circuit breaker ─────────────────────────────────────────────────────────

func (s *Store) circuitOpen() bool {
	opened := s.openedAt.Load()
	if opened == 0 {
		return false
	}
	// Half-open after ResetAfter — allow one probe to close circuit
	return time.Since(time.Unix(0, opened)) <= s.cfg.ResetAfter
}

func (s *Store) onSuccess() {
	s.failures.Store(0)
	s.openedAt.Store(0)
}

func (s *Store) onFailure() {
	n := s.failures.Add(1)
	if n >= s.cfg.MaxFailures {
		if s.openedAt.CompareAndSwap(0, time.Now().UnixNano()) {
			s.log.Warn("cache circuit breaker OPENED", zap.Int32("failures", n))
		}
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

// Get returns a cached response or nil on miss / open circuit.
// Never returns an error — always degrades gracefully.
func (s *Store) Get(ctx context.Context, key string) *CachedResponse {
	if s.circuitOpen() {
		return nil
	}
	data, err := s.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil
	}
	if err != nil {
		s.onFailure()
		s.log.Warn("cache GET error", zap.String("key", key), zap.Error(err))
		return nil
	}
	s.onSuccess()
	var resp CachedResponse
	if err2 := resp.UnmarshalBinary(data); err2 != nil {
		return nil
	}
	return &resp
}

// Set stores a response. Silently swallows errors — never blocks request path.
func (s *Store) Set(ctx context.Context, key string, resp *CachedResponse, ttl time.Duration) {
	if s.circuitOpen() {
		return
	}
	data, err := resp.MarshalBinary()
	if err != nil {
		return
	}
	if err2 := s.rdb.Set(ctx, key, data, ttl).Err(); err2 != nil {
		s.onFailure()
		s.log.Warn("cache SET error", zap.String("key", key), zap.Error(err2))
		return
	}
	s.onSuccess()
}

// Invalidate deletes all keys matching a Redis KEYS pattern.
func (s *Store) Invalidate(ctx context.Context, pattern string) (int64, error) {
	keys, err := s.rdb.Keys(ctx, pattern).Result()
	if err != nil || len(keys) == 0 {
		return 0, err
	}
	return s.rdb.Del(ctx, keys...).Result()
}

// TTLFor returns the appropriate TTL for a given request path.
func (s *Store) TTLFor(path string) time.Duration {
	switch {
	case len(path) > 14 && path[:14] == "/api/products/":
		// Individual product detail — cached long
		return s.cfg.ProductTTL
	case path == "/api/products" || (len(path) > 13 && path[:13] == "/api/products"):
		// Search / list results — shorter TTL
		return s.cfg.ListTTL
	default:
		return s.cfg.DefaultTTL
	}
}
