package middleware

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

func TestHTTPFailuresHaveExactlyOneDiagnosticWithCorrelation(t *testing.T) {
	for _, mode := range []string{"legacy", "context", "message_only", "panic"} {
		t.Run(mode, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			prev := slog.Default()
			slog.SetDefault(logger)
			defer slog.SetDefault(prev)
			h := RequestLogger(logger, nil)(Recover(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "legacy":
					pkg.Error(w, errors.New("failure"))
				case "context":
					pkg.ErrorCtx(r.Context(), w, 500, "failed", errors.New("failure"))
				case "message_only":
					pkg.ErrorWithMessage(w, 502, "failed")
				case "panic":
					panic("failure")
				}
			})))
			req := httptest.NewRequest(http.MethodGet, "/fail", nil)
			req.Header.Set("X-Request-Id", "req-diagnostic")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if strings.Count(output.String(), `"level":"ERROR"`) != 1 {
				t.Fatalf("duplicate or missing incident: %s", output.String())
			}
			if !strings.Contains(output.String(), `"request_id":"req-diagnostic"`) {
				t.Fatal(output.String())
			}
		})
	}
}

func TestCanceledCallerDoesNotBecomeHTTP500(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h := RequestLogger(logger, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { pkg.Error(w, context.Canceled) }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/cancel", nil).WithContext(ctx))
	if strings.Contains(output.String(), `"status":500`) || strings.Contains(output.String(), `"level":"ERROR"`) {
		t.Fatal(output.String())
	}
	if !strings.Contains(output.String(), `"status":499`) {
		t.Fatal("missing canceled-request observation")
	}
}
