// internal/middleware/cors.go — CORS middleware for the Gin router.
//
// Allows cross-origin requests from any origin so that frontend applications
// (local dev on localhost:3000, production on a different domain, mobile
// backends, third-party integrations) can call the proxy without being blocked
// by the browser's same-origin policy.
//
// Middleware order in main.go must place CORS() before SecurityHeaders() so
// that Access-Control-* headers are written before any downstream handler
// (including the cache layer) has a chance to flush the response.
//
// Preflight (OPTIONS) requests are answered immediately with 204 No Content
// and never forwarded to the upstream NestJS API or the cache store.
package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const (
	// corsMaxAge tells browsers they may cache the preflight result for 12 h,
	// reducing the number of OPTIONS round-trips in production.
	corsMaxAge = "43200"

	corsMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"

	// corsHeaders lists every request header the frontend is allowed to send.
	// Keeping this explicit (rather than "*") is required when
	// Access-Control-Allow-Credentials is true.
	corsHeaders = "Origin, Accept, Content-Type, Authorization, " +
		"X-Request-ID, X-Requested-With, Cache-Control"
)

// CORS returns a Gin middleware that adds the necessary Access-Control-*
// response headers to every request and short-circuits OPTIONS preflight
// requests with a 204 No Content response.
//
// Pass a *zap.Logger to enable per-request CORS debug logging; pass nil to
// skip logging (useful in tests).
func CORS(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")

		// ── Set CORS headers on every response ───────────────────────────────
		//
		// Using the request's Origin value (rather than the wildcard "*") lets
		// us also set Access-Control-Allow-Credentials: true, which is required
		// for requests that carry cookies or Authorization headers.
		//
		// If there is no Origin header (e.g. same-origin or server-to-server
		// calls) we still set the wildcard so that curl / Postman work without
		// extra flags.
		if origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			// Vary: Origin tells CDNs / reverse proxies to cache separate
			// responses per origin rather than serving one origin's CORS
			// headers to a different origin.
			c.Header("Vary", "Origin")
		} else {
			c.Header("Access-Control-Allow-Origin", "*")
		}

		c.Header("Access-Control-Allow-Methods", corsMethods)
		c.Header("Access-Control-Allow-Headers", corsHeaders)
		c.Header("Access-Control-Max-Age", corsMaxAge)

		// ── Preflight short-circuit ───────────────────────────────────────────
		//
		// Browsers send an OPTIONS request before any "non-simple" cross-origin
		// request (e.g. POST with JSON body, or any request with Authorization).
		// We must respond immediately — forwarding OPTIONS to the upstream would
		// return a 404/405 and break the preflight handshake.
		if c.Request.Method == http.MethodOptions {
			if log != nil {
				log.Debug("cors preflight",
					zap.String("origin", origin),
					zap.String("method", c.GetHeader("Access-Control-Request-Method")),
					zap.String("headers", c.GetHeader("Access-Control-Request-Headers")),
					zap.String("request_id", c.GetString("requestID")),
				)
			}
			c.AbortWithStatus(http.StatusNoContent) // 204
			return
		}

		// ── Log non-preflight cross-origin requests ───────────────────────────
		if log != nil && origin != "" {
			log.Debug("cors request",
				zap.String("origin", origin),
				zap.String("method", c.Request.Method),
				zap.String("path", c.Request.URL.Path),
				zap.String("request_id", c.GetString("requestID")),
			)
		}

		c.Next()
	}
}
