package logx

import (
	"context"
	"github.com/argeinfina/hichat/pkg"
	"log/slog"
	"strings"
)

// EmitAppEvent replaces paired stdout/AppLog calls with one structured event.
// A false return allows standalone services (without the bound application
// pipeline, e.g. tests) to retain their injected AppLogger fallback.
func EmitAppEvent(ctx context.Context, logger *slog.Logger, level, category string, userID, serverID *string, message string, metadata map[string]string) bool {
	l := slog.LevelWarn
	if level == "error" {
		l = slog.LevelError
	}
	code := metadata["event_code"]
	if code == "" {
		code = metadata["event"]
	}
	if code == "" {
		code = "APP_" + strings.ToUpper(level)
	}
	attrs := []slog.Attr{slog.String("category", category), slog.String("event_code", code)}
	if method, path := pkg.RequestInfoFrom(ctx); method != "" {
		attrs = append(attrs, slog.String("operation", method), slog.String("path", path), slog.Int64("duration_ms", pkg.RequestElapsedMillis(ctx)))
	}
	if userID != nil {
		attrs = append(attrs, slog.String("user_id", *userID))
	}
	if serverID != nil {
		attrs = append(attrs, slog.String("server_id", *serverID))
	}
	for k, v := range metadata {
		if k != "category" && k != "user_id" && k != "server_id" && k != "event_code" {
			attrs = append(attrs, slog.String(k, v))
		}
	}
	logger.LogAttrs(ctx, l, message, attrs...)
	return applicationSink.Load() != nil && logger.Enabled(ctx, l)
}
