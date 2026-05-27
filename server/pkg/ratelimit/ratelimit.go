// Package ratelimit provides IP-based login rate limiting
// and user-based message rate limiting.
package ratelimit

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// trustedProxies is the set of upstream proxy networks whose
// X-Forwarded-For / X-Real-IP headers we'll honour. Anything coming from
// outside these networks has its forwarded headers IGNORED — otherwise a
// direct attacker could spoof X-Forwarded-For and trivially bypass per-IP
// rate limits by rotating the header value across attempts.
//
// Defaults to loopback + IPv6 loopback (the HF Space deployment shape:
// requests reach the Go server through the in-Space proxy on 127.0.0.1).
// Override at boot via config.SetTrustedProxies — typically populated
// from the TRUSTED_PROXIES env var (comma-separated CIDR list).
var (
	trustedProxiesMu sync.RWMutex
	trustedProxies   = defaultTrustedProxies()
)

func defaultTrustedProxies() []netip.Prefix {
	v4Loop := netip.MustParsePrefix("127.0.0.0/8")
	v6Loop := netip.MustParsePrefix("::1/128")
	return []netip.Prefix{v4Loop, v6Loop}
}

// SetTrustedProxies replaces the trusted-proxy list at process boot.
// Pass nil or an empty slice to fall back to the loopback defaults.
// Invalid prefixes are skipped and reported in the error return so the
// caller (config.Load) can fail-fast on operator misconfiguration.
func SetTrustedProxies(cidrs []string) error {
	parsed := make([]netip.Prefix, 0, len(cidrs))
	for _, raw := range cidrs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// Accept both bare IPs (treat as /32 or /128) and full prefixes.
		if !strings.ContainsRune(raw, '/') {
			addr, err := netip.ParseAddr(raw)
			if err != nil {
				return fmt.Errorf("invalid trusted proxy IP %q: %w", raw, err)
			}
			bits := 32
			if addr.Is6() {
				bits = 128
			}
			parsed = append(parsed, netip.PrefixFrom(addr, bits))
			continue
		}
		p, err := netip.ParsePrefix(raw)
		if err != nil {
			return fmt.Errorf("invalid trusted proxy CIDR %q: %w", raw, err)
		}
		parsed = append(parsed, p)
	}
	if len(parsed) == 0 {
		parsed = defaultTrustedProxies()
	}
	trustedProxiesMu.Lock()
	trustedProxies = parsed
	trustedProxiesMu.Unlock()
	return nil
}

func isTrustedProxy(addr netip.Addr) bool {
	trustedProxiesMu.RLock()
	defer trustedProxiesMu.RUnlock()
	for _, p := range trustedProxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

type bucket struct {
	count       int
	windowStart time.Time
}

// LoginRateLimiter implements sliding-window rate limiting per IP address.
type LoginRateLimiter struct {
	mu          sync.RWMutex
	buckets     map[string]*bucket
	maxAttempts int
	window      time.Duration
	stopCleanup chan struct{}
}

func NewLoginRateLimiter(maxAttempts int, window time.Duration) *LoginRateLimiter {
	rl := &LoginRateLimiter{
		buckets:     make(map[string]*bucket),
		maxAttempts: maxAttempts,
		window:      window,
		stopCleanup: make(chan struct{}),
	}

	go rl.cleanupLoop()

	return rl
}

// Allow checks if a login attempt is permitted. Each call increments the counter.
// Call Reset() after successful login to clear the counter.
func (rl *LoginRateLimiter) Allow(ip string) bool {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[ip]
	if !exists {
		rl.buckets[ip] = &bucket{count: 1, windowStart: now}
		return true
	}

	if now.Sub(b.windowStart) > rl.window {
		b.count = 1
		b.windowStart = now
		return true
	}

	b.count++
	return b.count <= rl.maxAttempts
}

// Reset clears the counter after a successful login.
func (rl *LoginRateLimiter) Reset(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.buckets, ip)
}

// RetryAfterSeconds returns the remaining wait time for the Retry-After header.
func (rl *LoginRateLimiter) RetryAfterSeconds(ip string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	b, exists := rl.buckets[ip]
	if !exists {
		return 0
	}

	remaining := rl.window - time.Since(b.windowStart)
	if remaining < 0 {
		return 0
	}
	seconds := int(remaining.Seconds()) + 1
	return seconds
}

func (rl *LoginRateLimiter) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stopCleanup:
			return
		}
	}
}

func (rl *LoginRateLimiter) cleanup() {
	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	for ip, b := range rl.buckets {
		if now.Sub(b.windowStart) > rl.window {
			delete(rl.buckets, ip)
		}
	}
}

// ExtractIP returns the rate-limit key for the request.
//
// Trust model: forwarded headers (X-Forwarded-For, X-Real-IP) are only
// honoured when the TCP-level peer (r.RemoteAddr) is listed in the
// trusted-proxy set (see SetTrustedProxies). Anywhere else those
// headers are attacker-controlled and would let a remote client bypass
// per-IP rate limits by rotating the header value.
//
// Walks XFF right→left so chains like "client, proxy1, proxy2" reduce
// down to the first non-trusted hop ("client"). All-trusted chains
// collapse to the leftmost entry (best-effort).
func ExtractIP(r *http.Request) string {
	peerHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peerHost = r.RemoteAddr
	}
	peerAddr, peerOK := parseHostAddr(peerHost)

	if peerOK && isTrustedProxy(peerAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			// Right-to-left: the rightmost untrusted hop is the real
			// originator. Trusted proxies in the chain are skipped.
			for i := len(parts) - 1; i >= 0; i-- {
				candidate := strings.TrimSpace(parts[i])
				if candidate == "" {
					continue
				}
				addr, ok := parseHostAddr(candidate)
				if !ok {
					return candidate
				}
				if !isTrustedProxy(addr) {
					return candidate
				}
			}
			// Chain fully trusted (or malformed) → fall back to leftmost.
			leftmost := strings.TrimSpace(parts[0])
			if leftmost != "" {
				return leftmost
			}
		}
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			return strings.TrimSpace(xri)
		}
	}

	return peerHost
}

// parseHostAddr parses a host string into a netip.Addr, accepting both
// bracketed IPv6 ("[::1]") and bare formats. Returns (zero, false) if the
// host isn't a literal IP — DNS names aren't IPs and shouldn't be matched
// against the trusted-proxy CIDR set.
func parseHostAddr(host string) (netip.Addr, bool) {
	host = strings.TrimSpace(host)
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func FormatRetryMessage(seconds int) string {
	if seconds >= 60 {
		minutes := seconds / 60
		return fmt.Sprintf("%d minute(s)", minutes)
	}
	return fmt.Sprintf("%d second(s)", seconds)
}
