// Client-log handler tests — P3.1: client-supplied message and metadata
// values must be redacted (pkg.RedactSecrets) before landing in app_logs,
// since this endpoint accepts arbitrary free text from the browser/Electron
// client and a URL or error string embedded in it can carry a live token.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

// capturingAppLog records both message and metadata passed to Log, unlike
// stubAppLog in diagnostics_test.go which only tracks message strings — this
// package's redaction tests need to inspect metadata values too.
type capturingAppLog struct {
	mu       sync.Mutex
	messages []string
	metadata []map[string]string
}

func (s *capturingAppLog) Log(_ context.Context, _ models.LogLevel, _ models.LogCategory, _, _ *string, message string, metadata map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, message)
	s.metadata = append(s.metadata, metadata)
}
func (s *capturingAppLog) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (s *capturingAppLog) Clear(context.Context) error { return nil }
func (s *capturingAppLog) Start()                      {}
func (s *capturingAppLog) Stop()                       {}

var _ services.AppLogService = (*capturingAppLog)(nil)

func newClientLogRequest(t *testing.T, body clientLogRequest) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/client-log", bytes.NewReader(b))
	user := &models.User{ID: "user-1", Username: "tester"}
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
}

// TestClientLog_RedactsSecretInMessage — a token embedded in the free-text
// message field must be masked before it reaches app_logs.
func TestClientLog_RedactsSecretInMessage(t *testing.T) {
	logs := &capturingAppLog{}
	h := NewClientLogHandler(logs)

	req := newClientLogRequest(t, clientLogRequest{
		Level:   "error",
		Message: "auth_failed: token=SECRET123 retrying",
	})
	rec := httptest.NewRecorder()
	h.Log(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.messages) != 1 {
		t.Fatalf("got %d logged messages, want 1", len(logs.messages))
	}
	got := logs.messages[0]
	if strings.Contains(got, "SECRET123") {
		t.Errorf("message leaked the secret: %q", got)
	}
	if !strings.Contains(got, "token=***") {
		t.Errorf("message = %q, want it to contain %q", got, "token=***")
	}
}

// TestClientLog_RedactsSecretInMetadata — same guarantee for metadata
// values (e.g. a failing request URL that still carries its query string).
func TestClientLog_RedactsSecretInMetadata(t *testing.T) {
	logs := &capturingAppLog{}
	h := NewClientLogHandler(logs)

	req := newClientLogRequest(t, clientLogRequest{
		Level:   "error",
		Message: "network_request_failed",
		Metadata: map[string]string{
			"url": "https://api.example.com/x?token=SECRET456&mode=ro",
		},
	})
	rec := httptest.NewRecorder()
	h.Log(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.metadata) != 1 {
		t.Fatalf("got %d logged metadata entries, want 1", len(logs.metadata))
	}
	got := logs.metadata[0]["url"]
	if strings.Contains(got, "SECRET456") {
		t.Errorf("metadata leaked the secret: %q", got)
	}
	if !strings.Contains(got, "token=***") {
		t.Errorf("metadata = %q, want it to contain %q", got, "token=***")
	}
	if !strings.Contains(got, "mode=ro") {
		t.Errorf("metadata dropped trailing param: %q", got)
	}
}
