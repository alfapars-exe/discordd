package logx

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
)

// Go runs fn in a new goroutine with panic recovery.
//
// An unrecovered panic in any goroutine terminates the whole process — Go
// does not confine a panic to the goroutine that raised it. Every
// long-running background goroutine (async writers, hub loops, per-connection
// pumps) must therefore recover locally, or a single bad event/message can
// take the entire server down instead of just the one subsystem that failed.
//
// component identifies the subsystem in the log line (and, since this logs
// at Error, the resulting Sentry event) so a panic can be traced back to its
// origin. fn is NOT retried and the goroutine exits after a recovered panic —
// callers whose loop must keep running across transient failures should wrap
// the per-iteration work instead of the whole loop.
func Go(component string, fn func()) {
	go func() {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			slog.LogAttrs(context.Background(), slog.LevelError, "goroutine panic recovered",
				slog.String("component", component),
				slog.String("panic_type", fmt.Sprintf("%T", r)),
				slog.String("stack", string(debug.Stack())),
			)
		}()
		fn()
	}()
}
