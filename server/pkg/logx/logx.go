// Package logx wires the application's structured logging (slog) and optional
// Sentry error reporting.
//
// Init installs a process-global slog logger and bridges the standard library
// `log` package through it, so the many existing log.Printf("[component] ...")
// call sites keep working but now emit through one structured pipeline without
// being rewritten. Genuinely error-level events in hot paths should be migrated
// to native slog.Error calls over time — those also reach Sentry.
package logx

import (
	"context"
	"log"
	"log/slog"
	"os"
	"strings"

	"github.com/argeinfina/hichat/config"
)

// Init configures the global slog logger from cfg, initialises Sentry when a
// DSN is present, and routes the stdlib log package through slog. Call exactly
// once, early in main, before other subsystems start logging.
func Init(cfg config.LoggingConfig) {
	opts := &slog.HandlerOptions{Level: parseLevel(cfg.Level)}

	var handler slog.Handler
	if strings.EqualFold(cfg.Format, "text") {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	// Initialise Sentry first so error records can be forwarded to it. Errors
	// here are non-fatal — the app runs fine without error tracking.
	sentryEnabled, sentryErr := initSentry(cfg)
	if sentryEnabled {
		handler = newSentryHandler(handler)
	}

	slog.SetDefault(slog.New(handler))

	// Bridge the stdlib log package into slog. We drop stdlib flags because
	// slog stamps its own timestamp; the original "[component] message" text is
	// preserved as the slog message. The handler writes straight to stdout, not
	// back through the log package, so there is no recursion.
	log.SetFlags(0)
	log.SetOutput(&slogWriter{logger: slog.Default()})

	switch {
	case sentryErr != nil:
		slog.Warn("sentry init failed; continuing without error tracking", "error", sentryErr)
	case sentryEnabled:
		slog.Info("sentry error tracking enabled", "environment", cfg.Environment)
	}
}

// Component returns a logger tagged with a component attribute, mirroring the
// existing "[component] message" convention in structured form. Prefer this
// when migrating a hot path off stdlib log.
func Component(name string) *slog.Logger {
	return slog.Default().With("component", name)
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// slogWriter adapts io.Writer (what stdlib log writes to) onto slog. Each write
// is one log line, emitted at Info level since stdlib call sites carry no level
// information. The via_stdlog attribute marks bridged lines so they can be told
// apart from native slog calls during the gradual migration.
type slogWriter struct {
	logger *slog.Logger
}

func (w *slogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\n")
	w.logger.LogAttrs(context.Background(), slog.LevelInfo, msg, slog.Bool("via_stdlog", true))
	return len(p), nil
}
