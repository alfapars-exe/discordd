package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
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

func TestRequestLogger_RejectsUnsafeInboundXRequestId(t *testing.T) {
	// The inbound value is echoed into a response header and into every log
	// line for the request, so it has to be treated as untrusted input. A
	// rejected id must be REPLACED by a generated one, never truncated or
	// passed through — and the same value must reach the handler, the
	// response header and (by construction) the log.
	cases := []struct {
		name string
		id   string
	}{
		{"newline would split a log entry", "abc\ndef"},
		{"carriage return", "abc\rdef"},
		{"NUL byte", "abc\x00def"},
		{"space is not in the id alphabet", "abc def"},
		{"non-ASCII", "abcé"},
		{"over the length bound", strings.Repeat("a", maxInboundRequestIDLen+1)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotReqID string
			h := RequestLogger(discardLogger())(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				gotReqID = RequestID(r.Context())
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
			// Set directly on the map: http.Header.Set would be fine here,
			// but bypassing it documents that we are modelling a hostile
			// client, not a well-behaved one.
			req.Header["X-Request-Id"] = []string{tc.id}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if gotReqID == tc.id {
				t.Fatalf("unsafe inbound id was accepted verbatim: %q", gotReqID)
			}
			if !isSafeRequestID(gotReqID) {
				t.Errorf("generated fallback id is itself unsafe: %q", gotReqID)
			}
			if got := rec.Header().Get("X-Request-Id"); got != gotReqID {
				t.Errorf("response header %q disagrees with context id %q", got, gotReqID)
			}
		})
	}
}

func TestIsSafeRequestID_AcceptsRealWorldIDs(t *testing.T) {
	// The bound exists to stop abuse, not to reject legitimate correlation
	// ids. These are the shapes we actually expect to see.
	for _, id := range []string{
		"edge-supplied-42",
		uuid.NewString(),
		"4bf92f3577b34da6a3ce929d0e0e4736", // W3C trace-id
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // traceparent
		"req_1a2b3c",
		"host.example:1234",
		strings.Repeat("a", maxInboundRequestIDLen), // exactly at the bound
	} {
		if !isSafeRequestID(id) {
			t.Errorf("isSafeRequestID(%q) = false, want true", id)
		}
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
