// internal/cache/cache.go — Redis-backed response cache with circuit breaker.
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

type Config struct {
	DefaultTTL  time.Duration
	ProductTTL  time.Duration
	ListTTL     time.Duration
	MaxFailures int32
	ResetAfter  time.Duration
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

type CachedResponse struct {
	Status   int               `json:"s"`
	Headers  map[string]string `json:"h"`
	Body     []byte            `json:"b"`
	CachedAt int64             `json:"t"`
}

func (r *CachedResponse) MarshalBinary() ([]byte, error) { return json.Marshal(r) }
func (r *CachedResponse) UnmarshalBinary(d []byte) error { return json.Unmarshal(d, r) }

type Store struct {
	rdb      *redis.Client
	cfg      Config
	log      *zap.Logger
	failures atomic.Int32
	openedAt atomic.Int64
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

// ── Circuit breaker ──────────────────────────────────────────────────────────

func (s *Store) circuitOpen() bool {
	opened := s.openedAt.Load()
	if opened == 0 {
		return false
	}
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

// Invalidate deletes all keys matching a Redis glob pattern.
//
// FIX: Uses SCAN instead of KEYS — KEYS blocks Redis on large keyspaces
// and is banned/rate-limited on Upstash. SCAN is non-blocking and safe
// for production use.
func (s *Store) Invalidate(ctx context.Context, pattern string) (int64, error) {
	if s.circuitOpen() {
		return 0, nil
	}

	var cursor uint64
	var deleted int64

	for {
		keys, next, err := s.rdb.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			s.onFailure()
			return deleted, err
		}
		if len(keys) > 0 {
			n, err2 := s.rdb.Del(ctx, keys...).Result()
			if err2 != nil {
				s.onFailure()
				return deleted, err2
			}
			deleted += n
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}

	s.onSuccess()
	return deleted, nil
}

// TTLFor returns the appropriate TTL for a given request path.
// Admin routes are never cached — this is a safeguard in case
// noCachePath somehow misses an admin GET.
func (s *Store) TTLFor(path string) time.Duration {
	// Admin routes should never reach here (noCachePath blocks them),
	// but if they do — zero TTL means effectively no caching.
	if len(path) >= 10 && path[:10] == "/api/admin" {
		return 0
	}
	switch {
	case len(path) > 14 && path[:14] == "/api/products/":
		return s.cfg.ProductTTL
	case path == "/api/products" || (len(path) > 13 && path[:13] == "/api/products"):
		return s.cfg.ListTTL
	default:
		return s.cfg.DefaultTTL
	}
}
