package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestExtractIP_TrustGate covers the three operational modes for the IP
// extraction that backs per-IP rate limiting:
//
//  1. Untrusted peer with a spoofed X-Forwarded-For — the header must be
//     ignored. Pre-fix this was the rate-limit bypass.
//  2. Trusted peer (loopback by default) carrying a legitimate XFF — the
//     forwarded value is honoured.
//  3. Trusted peer with no forwarded header — we fall back to the peer
//     IP itself.
//
// resetTrustedProxies restores the loopback-only default at the start of
// every subtest so prior cases don't leak proxy entries.
func TestExtractIP_TrustGate(t *testing.T) {
	resetTrustedProxies(t)

	t.Run("untrusted peer XFF is ignored", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "203.0.113.5:1234" // not loopback, not in trusted set
		r.Header.Set("X-Forwarded-For", "1.2.3.4")
		got := ExtractIP(r)
		if got != "203.0.113.5" {
			t.Errorf("expected peer IP (203.0.113.5), got %q — spoofed XFF was trusted", got)
		}
	})

	t.Run("trusted loopback peer honors XFF", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-Forwarded-For", "198.51.100.7")
		got := ExtractIP(r)
		if got != "198.51.100.7" {
			t.Errorf("expected forwarded client IP, got %q", got)
		}
	})

	t.Run("trusted peer with XFF chain picks rightmost untrusted", func(t *testing.T) {
		// Configure both loopback (default) AND 10.0.0.1 as trusted, so
		// the rightmost untrusted entry "198.51.100.7" is the real client.
		if err := SetTrustedProxies([]string{"127.0.0.0/8", "::1/128", "10.0.0.0/24"}); err != nil {
			t.Fatalf("SetTrustedProxies: %v", err)
		}
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.1")
		got := ExtractIP(r)
		if got != "198.51.100.7" {
			t.Errorf("expected real client (rightmost untrusted), got %q", got)
		}
	})

	t.Run("trusted peer no XFF falls back to peer", func(t *testing.T) {
		resetTrustedProxies(t)
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:55555"
		// No XFF header at all.
		got := ExtractIP(r)
		if got != "127.0.0.1" {
			t.Errorf("expected peer IP fallback, got %q", got)
		}
	})

	t.Run("untrusted peer X-Real-IP is ignored", func(t *testing.T) {
		resetTrustedProxies(t)
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "203.0.113.99:9999"
		r.Header.Set("X-Real-IP", "1.2.3.4")
		got := ExtractIP(r)
		if got != "203.0.113.99" {
			t.Errorf("expected peer IP, got %q — X-Real-IP was trusted from untrusted peer", got)
		}
	})

	t.Run("trusted peer X-Real-IP is honored", func(t *testing.T) {
		resetTrustedProxies(t)
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-Real-IP", "192.0.2.50")
		got := ExtractIP(r)
		if got != "192.0.2.50" {
			t.Errorf("expected X-Real-IP value, got %q", got)
		}
	})
}

func TestSetTrustedProxies_InvalidInput(t *testing.T) {
	t.Cleanup(func() { resetTrustedProxies(t) })

	if err := SetTrustedProxies([]string{"not-an-ip"}); err == nil {
		t.Fatal("expected error for non-IP input, got nil")
	}
	if err := SetTrustedProxies([]string{"10.0.0.0/notanumber"}); err == nil {
		t.Fatal("expected error for malformed CIDR, got nil")
	}
}

func TestSetTrustedProxies_EmptyFallsBackToLoopback(t *testing.T) {
	t.Cleanup(func() { resetTrustedProxies(t) })

	if err := SetTrustedProxies(nil); err != nil {
		t.Fatalf("nil should succeed, got %v", err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.5")
	if got := ExtractIP(r); got != "203.0.113.5" {
		t.Errorf("loopback default should trust XFF, got %q", got)
	}
}

// resetTrustedProxies puts the global trust set back to loopback-only,
// matching the production default after a fresh boot with no
// TRUSTED_PROXIES env var.
func resetTrustedProxies(t *testing.T) {
	t.Helper()
	if err := SetTrustedProxies(nil); err != nil {
		t.Fatalf("reset trusted proxies: %v", err)
	}
}

// Compile-time guards — ensure the symbols the tests rely on stay
// exported with their current shapes. Renaming or changing the
// signature of these will break the build here, catching the change
// before it lands in callers (config.Load wires SetTrustedProxies on
// boot, every handler calls ExtractIP).
var (
	_ = ExtractIP
	_ = SetTrustedProxies
	_ = (*http.Request)(nil)
)
