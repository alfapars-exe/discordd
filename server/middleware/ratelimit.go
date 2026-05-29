package middleware

import (
	"fmt"
	"net/http"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
)

// IPRateLimiter is the slice of *ratelimit.LoginRateLimiter behaviour the IP
// rate-limit middleware needs. Keeping it an interface lets tests inject a
// deterministic limiter and lets callers pass nil to disable the limit.
type IPRateLimiter interface {
	Allow(key string) bool
	RetryAfterSeconds(key string) int
}

// RateLimitByIP returns middleware that rejects requests from a client IP that
// has exhausted the limiter's per-window budget, responding 429 with a
// Retry-After header. It throttles enumeration of public E2EE key material
// (audit P0-BD-02): GET /api/users/{id}/devices and .../prekey-bundles expose
// identity keys for arbitrary users, so an authenticated attacker could
// otherwise harvest the whole device-key database.
//
// The client IP is resolved via ratelimit.ExtractIP, which only honours
// X-Forwarded-For/X-Real-IP from trusted proxies — a direct attacker can't
// rotate the header to dodge the limit. A nil limiter disables the throttle.
func RateLimitByIP(limiter IPRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if limiter == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ratelimit.ExtractIP(r)
			if !limiter.Allow(ip) {
				w.Header().Set("Retry-After", fmt.Sprintf("%d", limiter.RetryAfterSeconds(ip)))
				pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "rate limit exceeded, please slow down")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
