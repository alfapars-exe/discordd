package pkg

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestIDFrom_returnsEmptyStringOnBareContext(t *testing.T) {
	if got := RequestIDFrom(context.Background()); got != "" {
		t.Errorf("bare context should carry no request id, got %q", got)
	}
}

func TestRequestIDFrom_returnsEmptyStringOnNilContext(t *testing.T) {
	// Nil ctx defensive path — some background jobs pass nil.
	//nolint:staticcheck // deliberate nil-context probe
	if got := RequestIDFrom(nil); got != "" {
		t.Errorf("nil context should return empty, got %q", got)
	}
}

func TestWithRequestID_thenRequestIDFrom_roundTripsValue(t *testing.T) {
	ctx := WithRequestID(context.Background(), "req-42")
	if got := RequestIDFrom(ctx); got != "req-42" {
		t.Errorf("round trip failed: got %q, want %q", got, "req-42")
	}
}

func TestWithRequestID_nilCtxUpgradesToBackground(t *testing.T) {
	//nolint:staticcheck // deliberate nil-context probe
	ctx := WithRequestID(nil, "req-nil-safe")
	if got := RequestIDFrom(ctx); got != "req-nil-safe" {
		t.Errorf("nil ctx path lost the id: %q", got)
	}
}

func TestRequestInfoFrom_returnsEmptyOnBareContext(t *testing.T) {
	method, path := RequestInfoFrom(context.Background())
	if method != "" || path != "" {
		t.Errorf("bare context should carry no request info, got (%q, %q)", method, path)
	}
}

func TestRequestInfoFrom_returnsEmptyOnNilContext(t *testing.T) {
	//nolint:staticcheck // deliberate nil-context probe
	method, path := RequestInfoFrom(nil)
	if method != "" || path != "" {
		t.Errorf("nil context should return empty, got (%q, %q)", method, path)
	}
}

func TestWithRequestInfo_thenRequestInfoFrom_roundTripsValue(t *testing.T) {
	ctx := WithRequestInfo(context.Background(), "POST", "/api/messages")
	method, path := RequestInfoFrom(ctx)
	if method != "POST" || path != "/api/messages" {
		t.Errorf("round trip failed: got (%q, %q)", method, path)
	}
}

func TestWithRequestInfo_nilCtxUpgradesToBackground(t *testing.T) {
	//nolint:staticcheck // deliberate nil-context probe
	ctx := WithRequestInfo(nil, "GET", "/health")
	method, path := RequestInfoFrom(ctx)
	if method != "GET" || path != "/health" {
		t.Errorf("nil ctx path lost the info: got (%q, %q)", method, path)
	}
}

// captureSlog swaps the default slog handler with one that records into
// buf so tests can assert on the "server error" log line ErrorCtx emits.
// Returns a cleanup that restores the previous default logger.
func captureSlog(t *testing.T) (*bytes.Buffer, func()) {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelError})))
	return buf, func() { slog.SetDefault(prev) }
}

func TestErrorCtx_500_logsRequestID_andReturnsGenericMessage(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ctx := WithRequestID(context.Background(), "req-abc")
	internal := errors.New("libsql: constraint 'users_email_key' failed") // must NOT reach client

	ErrorCtx(ctx, rec, http.StatusInternalServerError, "failed to save user", internal)

	// Response: generic message, no internal detail leaked (CWE-209).
	body := rec.Body.String()
	if strings.Contains(body, "libsql") || strings.Contains(body, "users_email_key") {
		t.Errorf("internal detail leaked to client: %s", body)
	}
	var env APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("bad JSON body: %v (%q)", err, body)
	}
	if env.Success {
		t.Error("Success=true on 500")
	}
	if env.Error != "failed to save user" {
		t.Errorf("Error field = %q, want the caller's user-safe message", env.Error)
	}

	// Log: contains the request_id AND the internal error text.
	logLine := buf.String()
	if !strings.Contains(logLine, `"request_id":"req-abc"`) {
		t.Errorf("log missing request_id: %s", logLine)
	}
	if !strings.Contains(logLine, "libsql") {
		t.Errorf("log missing internal detail (would defeat correlation): %s", logLine)
	}
}

func TestErrorCtx_500_emptyUserMsg_fallsBackToInternalServerError(t *testing.T) {
	_, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ErrorCtx(context.Background(), rec, http.StatusInternalServerError, "", errors.New("x"))

	var env APIResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if env.Error != "internal server error" {
		t.Errorf("fallback message = %q, want 'internal server error'", env.Error)
	}
}

func TestErrorCtx_setsCodeFromSentinel(t *testing.T) {
	_, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ErrorCtx(context.Background(), rec, http.StatusNotFound, "device not found", ErrDeviceNotFound)

	var env APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("bad JSON body: %v", err)
	}
	if env.Code != "NOT_FOUND" {
		t.Errorf("Code = %q, want NOT_FOUND", env.Code)
	}
}

func TestErrorCtx_500_forcesInternalCode_evenWith4xxSentinel(t *testing.T) {
	_, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	// A 5xx status paired with an err wrapping a 4xx sentinel must not leak the
	// sentinel's code — status and code have to agree.
	ErrorCtx(context.Background(), rec, http.StatusInternalServerError,
		"failed to load device", fmt.Errorf("lookup: %w", ErrDeviceNotFound))

	var env APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("bad JSON body: %v", err)
	}
	if env.Code != "INTERNAL" {
		t.Errorf("Code = %q, want INTERNAL (5xx must not carry a 4xx sentinel code)", env.Code)
	}
	if env.Error != "failed to load device" {
		t.Errorf("Error = %q, want the user message", env.Error)
	}
}

func TestErrorCtx_4xx_passesUserMsgThrough_andDoesNotLog(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ErrorCtx(context.Background(), rec, http.StatusBadRequest, "email is required", nil)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	var env APIResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if env.Error != "email is required" {
		t.Errorf("Error = %q, want passthrough of user message", env.Error)
	}
	if buf.Len() > 0 {
		t.Errorf("4xx should not log — log buffer got: %s", buf.String())
	}
}

func TestErrorCtx_500_logsMethodAndPath_whenSetOnCtx(t *testing.T) {
	buf, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ctx := WithRequestID(context.Background(), "req-mp")
	ctx = WithRequestInfo(ctx, "POST", "/api/devices/register")

	ErrorCtx(ctx, rec, http.StatusInternalServerError, "failed to register device", errors.New("db error"))

	logLine := buf.String()
	if !strings.Contains(logLine, `"method":"POST"`) {
		t.Errorf("log missing method: %s", logLine)
	}
	if !strings.Contains(logLine, `"path":"/api/devices/register"`) {
		t.Errorf("log missing path: %s", logLine)
	}
}

func TestErrorCtx_500_nilErr_stillLogsAndReturnsGeneric(t *testing.T) {
	// A caller may know the state is bad without wrapping an error (e.g.
	// "config missing" detected via zero-value check). ErrorCtx still logs
	// the status + request_id and returns generic — nil err is fine.
	buf, restore := captureSlog(t)
	defer restore()

	rec := httptest.NewRecorder()
	ctx := WithRequestID(context.Background(), "req-nil-err")
	ErrorCtx(ctx, rec, http.StatusInternalServerError, "config invariant broken", nil)

	logLine := buf.String()
	if !strings.Contains(logLine, `"request_id":"req-nil-err"`) {
		t.Errorf("log missing request_id: %s", logLine)
	}
	if !strings.Contains(logLine, `"status":500`) {
		t.Errorf("log missing status: %s", logLine)
	}
}
