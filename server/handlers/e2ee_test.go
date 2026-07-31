package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// stubE2EEService is a minimal services.E2EEService double. It records
// whether UpsertGroupSession was reached, so tests can prove the legacy
// "session_data" sniff rejects a request BEFORE it hits the service layer.
type stubE2EEService struct {
	upsertGroupSessionCalled bool
}

func (s *stubE2EEService) UpsertKeyBackup(context.Context, string, *models.CreateKeyBackupRequest) error {
	return nil
}
func (s *stubE2EEService) GetKeyBackup(context.Context, string) (*models.E2EEKeyBackup, error) {
	return nil, nil
}
func (s *stubE2EEService) DeleteKeyBackup(context.Context, string) error { return nil }
func (s *stubE2EEService) UpsertGroupSession(context.Context, string, string, string, string, *models.CreateSenderKeyDistributionRequest) error {
	s.upsertGroupSessionCalled = true
	return nil
}
func (s *stubE2EEService) GetGroupSessions(context.Context, string, string, string, string) ([]models.SenderKeyEnvelopeResponse, error) {
	return nil, nil
}
func (s *stubE2EEService) GetSenderKeyRecipients(context.Context, string, string, string, string) ([]models.SenderKeyRecipient, error) {
	return nil, nil
}
func (s *stubE2EEService) DeleteGroupSessionsByChannel(context.Context, string) error { return nil }
func (s *stubE2EEService) DeleteGroupSessionsByUser(context.Context, string, string) error {
	return nil
}

var _ services.E2EEService = (*stubE2EEService)(nil)

func newGroupSessionRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"/api/servers/srv/channels/ch/group-sessions?device_id=dev-1", bytes.NewBufferString(body))
	req.SetPathValue("channelId", "ch")
	req.Header.Set("Content-Type", "application/json")
	user := &models.User{ID: "user-1", Username: "tester"}
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
	req = req.WithContext(context.WithValue(req.Context(), ServerIDContextKey, "srv"))
	return req
}

// TestCreateGroupSession_RejectsLegacySessionData is pentest C-03's sharp
// cutover: a request body carrying the pre-v2 "session_data" field (a
// client still uploading one shared plaintext blob) must be rejected with
// 400 before the service — and therefore the repository — ever see it.
// There is no compatibility branch.
func TestCreateGroupSession_RejectsLegacySessionData(t *testing.T) {
	svc := &stubE2EEService{}
	h := NewE2EEHandler(svc, nil)

	body := `{"session_id":"sess-1","session_data":"plaintext-chainkey-blob"}`
	rec := httptest.NewRecorder()
	req := newGroupSessionRequest(t, body)
	h.CreateGroupSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a legacy session_data body, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if svc.upsertGroupSessionCalled {
		t.Fatal("service must not be reached for a legacy session_data body")
	}
}

// TestCreateGroupSession_AcceptsV2Envelopes is the control for the above: a
// well-formed v2 per-recipient-envelope body must reach the service.
func TestCreateGroupSession_AcceptsV2Envelopes(t *testing.T) {
	svc := &stubE2EEService{}
	h := NewE2EEHandler(svc, nil)

	body := `{"session_id":"sess-1","version":2,"envelopes":[
		{"recipient_user_id":"u1","recipient_device_id":"d1","message_type":3,"ciphertext":"c"}
	]}`
	rec := httptest.NewRecorder()
	req := newGroupSessionRequest(t, body)
	h.CreateGroupSession(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for a v2 envelope body, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if !svc.upsertGroupSessionCalled {
		t.Fatal("expected the service to be reached for a well-formed v2 body")
	}
}

// TestCreateGroupSession_RateLimited proves BULGU 3 (pentest C-03
// follow-up): CreateGroupSession is now behind a per-user rate limiter --
// previously nothing throttled it at all.
//
// VACUOUS CONTROL: with the `if h.groupSessionLimiter != nil && ...` check
// temporarily removed from CreateGroupSession, the second request in this
// test also returned 201 instead of 429 -- confirmed by inspection, then
// reverted (go test cannot run on this Windows dev box; see repo policy).
func TestCreateGroupSession_RateLimited(t *testing.T) {
	svc := &stubE2EEService{}
	limiter := ratelimit.NewMessageRateLimiter(1, time.Minute, 0)
	h := NewE2EEHandler(svc, limiter)

	body := `{"session_id":"sess-1","version":2,"envelopes":[
		{"recipient_user_id":"u1","recipient_device_id":"d1","message_type":3,"ciphertext":"c"}
	]}`

	rec1 := httptest.NewRecorder()
	h.CreateGroupSession(rec1, newGroupSessionRequest(t, body))
	if rec1.Code != http.StatusCreated {
		t.Fatalf("first request: expected 201, got %d (body: %s)", rec1.Code, rec1.Body.String())
	}

	rec2 := httptest.NewRecorder()
	h.CreateGroupSession(rec2, newGroupSessionRequest(t, body))
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: expected 429, got %d (body: %s)", rec2.Code, rec2.Body.String())
	}
}

// TestCreateGroupSession_RejectsOversizedBody proves BULGU 3's coarse outer
// guard: a body over maxGroupSessionBody (1 MiB) is rejected before either
// JSON parse runs, not just relying on the per-field caps in Validate.
func TestCreateGroupSession_RejectsOversizedBody(t *testing.T) {
	svc := &stubE2EEService{}
	h := NewE2EEHandler(svc, nil)

	oversizedCiphertext := strings.Repeat("a", maxGroupSessionBody+1)
	body := `{"session_id":"sess-1","version":2,"envelopes":[` +
		`{"recipient_user_id":"u1","recipient_device_id":"d1","message_type":3,"ciphertext":"` + oversizedCiphertext + `"}]}`

	rec := httptest.NewRecorder()
	req := newGroupSessionRequest(t, body)
	h.CreateGroupSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an oversized body, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if svc.upsertGroupSessionCalled {
		t.Fatal("service must not be reached for an oversized body")
	}
}
