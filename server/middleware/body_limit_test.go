package middleware

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestBodyLimit_RejectsOversizedNonMultipartBody proves the resource scan
// 2026-07-31 finding N-14 fix: a non-multipart body over the cap is
// rejected once the handler tries to read past it.
func TestBodyLimit_RejectsOversizedNonMultipartBody(t *testing.T) {
	const cap = 1024
	var readErr error
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	})
	handler := BodyLimit(cap)(next)

	body := bytes.Repeat([]byte("a"), cap+1)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if readErr == nil {
		t.Fatal("expected a body-too-large error, got nil")
	}
	var maxErr *http.MaxBytesError
	if !errors.As(readErr, &maxErr) {
		t.Fatalf("expected *http.MaxBytesError, got %T: %v", readErr, readErr)
	}
}

// TestBodyLimit_MultipartRequestsUnaffected is the POSITIVE control this
// finding calls out explicitly: a multipart request over the JSON cap must
// pass through untouched -- otherwise the global middleware would silently
// truncate every upload endpoint (avatar, badge, diagnostics, dm, feedback,
// message, report, soundboard), which apply their own, much larger, caps.
func TestBodyLimit_MultipartRequestsUnaffected(t *testing.T) {
	const cap = 1024
	var readErr error
	var readLen int
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		readErr = err
		readLen = len(data)
	})
	handler := BodyLimit(cap)(next)

	body := bytes.Repeat([]byte("a"), cap*4) // far over the JSON cap
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if readErr != nil {
		t.Fatalf("multipart request must not be capped by BodyLimit, got err: %v", readErr)
	}
	if readLen != len(body) {
		t.Fatalf("multipart body truncated: got %d bytes, want %d", readLen, len(body))
	}
}

// TestBodyLimit_NestedReaderKeepsTighterLimit proves the inner/outer
// http.MaxBytesReader nesting claim in BodyLimit's doc comment: a handler
// that wraps r.Body in its own smaller cap (mirrors handlers/client_log.go's
// maxClientLogBody = 16 KiB) still enforces that tighter limit even though
// it sits under the global cap.
func TestBodyLimit_NestedReaderKeepsTighterLimit(t *testing.T) {
	const globalCap = 8 << 20  // mirrors MaxRequestBodyBytes
	const innerCap = 16 * 1024 // mirrors handlers.maxClientLogBody

	var readErr error
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, innerCap)
		_, readErr = io.ReadAll(r.Body)
	})
	handler := BodyLimit(globalCap)(next)

	// 20 KiB: over the inner 16 KiB cap, comfortably under the outer 8 MiB cap.
	body := bytes.Repeat([]byte("a"), 20*1024)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if readErr == nil {
		t.Fatal("expected the inner 16 KiB cap to still reject a 20 KiB body")
	}
	var maxErr *http.MaxBytesError
	if !errors.As(readErr, &maxErr) {
		t.Fatalf("expected *http.MaxBytesError, got %T: %v", readErr, readErr)
	}
}
