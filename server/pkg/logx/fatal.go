package logx

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

// Fatal records an unrecoverable process error at its actual severity and exits.
// Unlike log.Fatal, it does not pass through the Info-only standard-log bridge.
// Resolve the current default logger at call time: startup can fail before or
// after Init. As with log.Fatal, deferred cleanup does not run after this call.
func Fatal(component, message string, err error) {
	attrs := []slog.Attr{slog.String("component", component)}
	if err != nil {
		attrs = append(attrs, slog.String("err", pkg.ErrText(err)))
	}
	slog.Default().LogAttrs(context.Background(), slog.LevelError, pkg.RedactSecrets(message), attrs...)
	Flush(2 * time.Second)
	os.Exit(1)
}
