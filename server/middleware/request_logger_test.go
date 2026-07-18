package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

func TestRequestLogger_SetsRequestIDAndCapturesStatus(t *testing.T) {
	var gotReqID string
	h := RequestLogger(discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotReqID = RequestID(r.Context())
		w.WriteHeader(http.StatusCreated)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	if gotReqID == "" {
		t.Fatal("request id missing from handler context")
	}
	if got := rec.Header().Get("X-Request-Id"); got != gotReqID {
		t.Fatalf("X-Request-Id header %q != context id %q", got, gotReqID)
	}
}

func TestRequestLogger_SkipsWebSocketPath(t *testing.T) {
	called := false
	h := RequestLogger(discardLogger())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if RequestID(r.Context()) != "" {
			t.Error("request id should not be assigned on /ws")
		}
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws", nil))

	if !called {
		t.Fatal("next handler was not called for /ws")
	}
	if rec.Header().Get("X-Request-Id") != "" {
		t.Error("X-Request-Id should not be set on /ws")
	}
}

func TestRequestLogger_HonorsInboundXRequestId(t *testing.T) {
	// A client-set X-Request-Id must be preserved end-to-end. Edge
	// proxies and retry loops rely on this so their trace correlates
	// with ours; regenerating one here would break that story.
	var gotReqID string
	h := RequestLogger(discardLogger())(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotReqID = RequestID(r.Context())
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("X-Request-Id", "edge-supplied-42")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if gotReqID != "edge-supplied-42" {
		t.Errorf("inbound request id dropped: got %q, want %q", gotReqID, "edge-supplied-42")
	}
	if got := rec.Header().Get("X-Request-Id"); got != "edge-supplied-42" {
		t.Errorf("response X-Request-Id = %q, want the inbound value", got)
	}
}

func TestRequestLogger_AlsoWritesIntoPkgRequestIDKey(t *testing.T) {
	// pkg.ErrorCtx reads request_id via pkg.RequestIDFrom (its own key,
	// no import of middleware). Middleware must publish into that key
	// too so ErrorCtx sees the same id middleware sees. Losing this
	// would silently drop request correlation from every 500 log line.
	var pkgSideID string
	h := RequestLogger(discardLogger())(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		pkgSideID = pkg.RequestIDFrom(r.Context())
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))

	if pkgSideID == "" {
		t.Fatal("pkg.RequestIDFrom returned empty — middleware isn't publishing into pkg's key")
	}
	if pkgSideID != rec.Header().Get("X-Request-Id") {
		t.Fatalf("pkg-side id %q != response header %q — keys are out of sync",
			pkgSideID, rec.Header().Get("X-Request-Id"))
	}
}
