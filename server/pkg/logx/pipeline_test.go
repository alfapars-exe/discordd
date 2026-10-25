package logx

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

func TestComponentResolvesHandlerAfterInitialization(t *testing.T) {
	early := Component("early.component")
	previous := slog.Default()
	t.Cleanup(func() { SetAppSink(nil); slog.SetDefault(previous) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(&pipelineHandler{next: slog.NewJSONHandler(&output, nil)}))
	var seen []slog.Record
	SetAppSink(func(_ context.Context, r slog.Record) { seen = append(seen, r.Clone()) })
	early.ErrorContext(pkg.WithRequestID(context.Background(), "req-early"), "failure", "event_code", "EARLY_FAILURE", "err", "bad connection")
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	if row["level"] != "ERROR" || row["component"] != "early.component" || row["request_id"] != "req-early" || row["via_stdlog"] != nil {
		t.Fatalf("wrong structured event: %v", row)
	}
	if len(seen) != 1 {
		t.Fatalf("sink received %d events", len(seen))
	}
}

func TestPipelineSanitizesAllSinksAndExcludesRecursiveAndAccessEvents(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { SetAppSink(nil); slog.SetDefault(previous) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(&pipelineHandler{next: slog.NewJSONHandler(&output, nil)}))
	seen := 0
	SetAppSink(func(_ context.Context, r slog.Record) {
		seen++
		var b bytes.Buffer
		_ = slog.NewJSONHandler(&b, nil).Handle(context.Background(), r)
		if strings.Contains(b.String(), "NEVER_LOG") {
			t.Errorf("sink leaked secret: %s", b.String())
		}
		Component("service.applog").Error("write failed") // must not re-enter sink
	})
	Component("test").With("password", "NEVER_LOG").Error("failure postgres://user:NEVER_LOG@host/db", "nested", map[string]any{"Authorization": "NEVER_LOG", "safe": "token=NEVER_LOG"})
	slog.Error("http request", "event_kind", "http_access")
	if seen != 1 {
		t.Fatalf("sink recursion/access duplicate: %d", seen)
	}
	if strings.Contains(output.String(), "NEVER_LOG") {
		t.Fatalf("stdout leaked: %s", output.String())
	}
}

func TestStandardBridgeRecognizesSeverity(t *testing.T) {
	var output bytes.Buffer
	w := slogWriter{logger: slog.New(slog.NewJSONHandler(&output, nil))}
	_, _ = w.Write([]byte("ERROR failed password=NEVER_LOG\n"))
	if !strings.Contains(output.String(), `"level":"ERROR"`) || strings.Contains(output.String(), "NEVER_LOG") {
		t.Fatal(output.String())
	}
}

func TestPipelineKeepsGroupedAttributesAndBoundsDiagnosticSize(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { SetAppSink(nil); slog.SetDefault(previous) })
	var output bytes.Buffer
	slog.SetDefault(slog.New(&pipelineHandler{next: slog.NewJSONHandler(&output, nil)}))
	Component("grouped").WithGroup("request").With("method", "GET").Error("failed", "path", "/example", "token", "NEVER_LOG")
	var row map[string]any
	if err := json.Unmarshal(output.Bytes(), &row); err != nil {
		t.Fatal(err)
	}
	request := row["request"].(map[string]any)
	if request["method"] != "GET" || request["path"] != "/example" || request["token"] != "***" {
		t.Fatalf("group fields lost: %v", row)
	}
	output.Reset()
	attrs := make([]any, 0, 100)
	for i := 0; i < 50; i++ {
		attrs = append(attrs, "huge", strings.Repeat("\\\"", 4000))
	}
	slog.Error(strings.Repeat("\x01", 1024), attrs...)
	if output.Len() > 8192 {
		t.Fatalf("diagnostic too large: %d", output.Len())
	}
}
