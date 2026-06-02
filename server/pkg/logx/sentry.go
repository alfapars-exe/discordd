package logx

import (
	"context"
	"log/slog"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/getsentry/sentry-go"
)

// sentryEnabled is set once by initSentry. Guards every Sentry call so the
// package is a no-op when no DSN is configured (local dev / self-host).
var sentryEnabled bool

// initSentry initialises the global Sentry hub when a DSN is configured.
// Returns whether Sentry is enabled and any init error. A failure is
// non-fatal: the caller logs it and continues without error tracking.
func initSentry(cfg config.LoggingConfig) (bool, error) {
	if cfg.SentryDSN == "" {
		return false, nil
	}
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              cfg.SentryDSN,
		Environment:      cfg.Environment,
		Release:          cfg.Release,
		AttachStacktrace: true,
	}); err != nil {
		return false, err
	}
	sentryEnabled = true
	return true, nil
}

// Flush waits up to timeout for buffered Sentry events to be delivered. Call
// during graceful shutdown so the last errors aren't lost on exit. No-op when
// Sentry is disabled.
func Flush(timeout time.Duration) {
	if sentryEnabled {
		sentry.Flush(timeout)
	}
}

// sentryHandler is an slog.Handler middleware that forwards Error-and-above
// records to Sentry while delegating every record to the wrapped handler for
// normal stdout output. Below-Error records (including the bridged stdlib log
// lines, which arrive at Info) never reach Sentry, keeping the signal clean.
type sentryHandler struct {
	next  slog.Handler
	attrs []slog.Attr
}

func newSentryHandler(next slog.Handler) slog.Handler {
	return &sentryHandler{next: next}
}

func (h *sentryHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *sentryHandler) Handle(ctx context.Context, r slog.Record) error {
	if sentryEnabled && r.Level >= slog.LevelError {
		// v0.46 dropped Event.Extra; structured data now goes through Contexts
		// (Context is map[string]interface{}). Group all slog attrs under one
		// "attributes" context card.
		attrs := sentry.Context{}
		for _, a := range h.attrs {
			attrs[a.Key] = a.Value.Any()
		}
		r.Attrs(func(a slog.Attr) bool {
			attrs[a.Key] = a.Value.Any()
			return true
		})

		event := sentry.NewEvent()
		event.Level = sentry.LevelError
		event.Message = r.Message
		if len(attrs) > 0 {
			event.Contexts = map[string]sentry.Context{"attributes": attrs}
		}
		sentry.CaptureEvent(event)
	}
	return h.next.Handle(ctx, r)
}

func (h *sentryHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	merged := make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	merged = append(merged, h.attrs...)
	merged = append(merged, attrs...)
	return &sentryHandler{next: h.next.WithAttrs(attrs), attrs: merged}
}

func (h *sentryHandler) WithGroup(name string) slog.Handler {
	return &sentryHandler{next: h.next.WithGroup(name), attrs: h.attrs}
}
