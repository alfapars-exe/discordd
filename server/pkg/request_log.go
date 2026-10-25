package pkg

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

type requestLogKey struct{}
type requestLogState struct {
	reported atomic.Bool
	started  time.Time
}

func WithRequestLogState(ctx context.Context) context.Context {
	return context.WithValue(ctx, requestLogKey{}, &requestLogState{started: time.Now()})
}

func RequestElapsedMillis(ctx context.Context) int64 {
	if ctx == nil {
		return 0
	}
	if s, ok := ctx.Value(requestLogKey{}).(*requestLogState); ok {
		return time.Since(s.started).Milliseconds()
	}
	return 0
}
func RequestErrorReported(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	s, _ := ctx.Value(requestLogKey{}).(*requestLogState)
	return s != nil && s.reported.Load()
}
func ClaimRequestError(ctx context.Context) bool {
	if ctx == nil {
		return true
	}
	s, _ := ctx.Value(requestLogKey{}).(*requestLogState)
	return s == nil || s.reported.CompareAndSwap(false, true)
}

// ResponseLogContext lets legacy response helpers use the request context
// without importing middleware. Unwrapping accommodates nested writers.
func ResponseLogContext(w http.ResponseWriter) context.Context {
	for i := 0; i < 16; i++ {
		if cw, ok := w.(interface{ LogContext() context.Context }); ok {
			return cw.LogContext()
		}
		if u, ok := w.(interface{ Unwrap() http.ResponseWriter }); ok {
			w = u.Unwrap()
		} else {
			break
		}
	}
	return nil
}

// DiagnosticError emits the single diagnostic event for an HTTP failure.
// Access records remain separate observations, never separate incidents.
func DiagnosticError(ctx context.Context, status int, code, kind string, err error, extra ...slog.Attr) {
	if !ClaimRequestError(ctx) {
		return
	}
	level := slog.LevelError
	if kind == "upstream" || kind == "timeout" {
		level = slog.LevelWarn
	}
	method, path := RequestInfoFrom(ctx)
	attrs := []slog.Attr{slog.String("component", "http"), slog.String("event_code", code), slog.String("error_kind", kind), slog.Int("status", status), slog.String("request_id", RequestIDFrom(ctx)), slog.String("method", method), slog.String("path", path), slog.String("err", ErrText(err))}
	attrs = append(attrs, slog.String("operation", method), slog.Int64("duration_ms", RequestElapsedMillis(ctx)))
	attrs = append(attrs, extra...)
	slog.LogAttrs(ctx, level, "server error", attrs...)
}

// ErrorCtxCode is for classified upstream failures with a stable public code.
func ErrorCtxCode(ctx context.Context, w http.ResponseWriter, status int, message, code, kind string, err error, extra ...slog.Attr) {
	if ctx.Err() != nil && kind == "client_canceled" {
		return
	}
	if status >= 500 {
		DiagnosticError(ctx, status, code, kind, err, extra...)
	}
	writeError(w, status, message, code, RequestIDFrom(ctx))
}
