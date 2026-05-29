package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg/ratelimit"
)

// TestRateLimitByIP_BlocksAfterBudget proves the enumeration throttle:
// after the per-window budget is spent for an IP, further requests are
// rejected with 429 + Retry-After and never reach the wrapped handler.
func TestRateLimitByIP_BlocksAfterBudget(t *testing.T) {
	limiter := ratelimit.NewLoginRateLimiter(2, time.Minute) // 2 per window

	var served int
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served++
		w.WriteHeader(http.StatusOK)
	})
	handler := RateLimitByIP(limiter)(next)

	doReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/users/u1/devices", nil)
		req.RemoteAddr = "203.0.113.7:54321" // not a trusted proxy → keyed by this IP
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	if rec := doReq(); rec.Code != http.StatusOK {
		t.Fatalf("request 1: want 200, got %d", rec.Code)
	}
	if rec := doReq(); rec.Code != http.StatusOK {
		t.Fatalf("request 2: want 200, got %d", rec.Code)
	}

	rec := doReq()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request 3: want 429, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("request 3: expected a Retry-After header on the 429")
	}
	if served != 2 {
		t.Fatalf("wrapped handler should have run exactly twice, ran %d times", served)
	}
}

// TestRateLimitByIP_NilLimiterPassesThrough keeps the middleware safe to wire
// with a disabled (nil) limiter.
func TestRateLimitByIP_NilLimiterPassesThrough(t *testing.T) {
	var served int
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served++
		w.WriteHeader(http.StatusOK)
	})
	handler := RateLimitByIP(nil)(next)

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.RemoteAddr = "203.0.113.8:1"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("nil limiter request %d: want 200, got %d", i, rec.Code)
		}
	}
	if served != 5 {
		t.Fatalf("nil limiter: expected 5 served, got %d", served)
	}
}
