package logx

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

type capturedSentryTransport struct{ events []*sentry.Event }

func (t *capturedSentryTransport) Configure(sentry.ClientOptions)        {}
func (t *capturedSentryTransport) SendEvent(e *sentry.Event)             { t.events = append(t.events, e) }
func (t *capturedSentryTransport) Flush(time.Duration) bool              { return true }
func (t *capturedSentryTransport) FlushWithContext(context.Context) bool { return true }
func (t *capturedSentryTransport) Close()                                {}

func TestSentryReceivesSanitizedStructuredIncidentOnlyOnce(t *testing.T) {
	transport := &capturedSentryTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://public@example.invalid/1", Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	hub := sentry.CurrentHub()
	previous, enabled := hub.Client(), sentryEnabled
	hub.BindClient(client)
	sentryEnabled = true
	defer func() { hub.BindClient(previous); sentryEnabled = enabled }()
	logger := slog.New(&pipelineHandler{next: newSentryHandler(slog.NewJSONHandler(io.Discard, nil))}).With("component", "privacy", "event_code", "TEST_FAILURE")
	logger.WithGroup("request").With("method", "GET").Error("failure", "token", "NEVER_LOG", "path", "/safe")
	logger.Warn("temporary upstream issue")
	logger.Error("http request", "event_kind", "http_access")
	if len(transport.events) != 1 {
		t.Fatalf("Sentry incidents=%d", len(transport.events))
	}
	event := transport.events[0]
	group, ok := event.Contexts["attributes"]["request"].(map[string]any)
	if !ok || group["token"] != "***" || group["method"] != "GET" || group["path"] != "/safe" {
		t.Fatalf("Sentry group=%v", group)
	}
	if event.Tags["event_code"] != "TEST_FAILURE" || len(event.Fingerprint) != 3 {
		t.Fatalf("missing stable grouping: %+v", event)
	}
}
