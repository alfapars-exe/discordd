package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
