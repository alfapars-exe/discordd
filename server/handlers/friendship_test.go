package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// stubFriendshipService records whether SendRequest reached the service so
// the rate-limit test can prove a 429 short-circuits before delegation.
type stubFriendshipService struct {
	sendCalled bool
}

func (s *stubFriendshipService) AreFriends(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s *stubFriendshipService) SendRequest(_ context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error) {
	s.sendCalled = true
	return &models.FriendshipWithUser{ID: "fr-1", Status: models.FriendshipStatusPending, UserID: "user-2", Username: req.Username}, nil
}
func (s *stubFriendshipService) AcceptRequest(context.Context, string, string) (*models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendshipService) DeclineRequest(context.Context, string, string) error { return nil }
func (s *stubFriendshipService) RemoveFriend(context.Context, string, string) error   { return nil }
func (s *stubFriendshipService) ListFriends(context.Context, string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendshipService) ListRequests(context.Context, string) (*services.FriendRequestsResponse, error) {
	return nil, nil
}
func (s *stubFriendshipService) SetDMAcceptor(services.DMRequestAcceptor) {}
func (s *stubFriendshipService) SetEmailEnqueuer(services.EmailEnqueuer)  {}

var _ services.FriendshipService = (*stubFriendshipService)(nil)

func newSendFriendRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/friends/requests", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	// Inject an authenticated user — SendRequest() requires UserContextKey set.
	user := &models.User{ID: "user-1", Username: "tester"}
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
	return req
}

// TestSendRequest_RateLimit — POST /api/friends/requests is rate-limited per
// user (Faz B, 2026-10-21): each call pushes a WS event and an inbox row to
// the target, so an unthrottled caller could spam someone. Requests within
// budget reach the service; once exhausted, the handler answers 429 with a
// Retry-After header and never calls the service for the rejected request.
func TestSendRequest_RateLimit(t *testing.T) {
	svc := &stubFriendshipService{}
	limiter := ratelimit.NewMessageRateLimiter(2, time.Minute, 30*time.Second)
	h := NewFriendshipHandler(svc, limiter)

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.SendRequest(rec, newSendFriendRequest(t, `{"username":"bob"}`))
		if rec.Code != http.StatusCreated {
			t.Fatalf("request %d: expected 201, got %d (body: %s)", i+1, rec.Code, rec.Body.String())
		}
	}
	if !svc.sendCalled {
		t.Fatal("SendRequest should have reached the service for in-budget requests")
	}

	svc.sendCalled = false
	rec := httptest.NewRecorder()
	h.SendRequest(rec, newSendFriendRequest(t, `{"username":"bob"}`))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 response")
	}
	if svc.sendCalled {
		t.Fatal("service must NOT be called once the rate limit is exceeded")
	}
}

// TestSendRequest_NilLimiterAllows — a nil limiter disables the check so
// existing callers/tests that construct the handler without one keep working.
func TestSendRequest_NilLimiterAllows(t *testing.T) {
	svc := &stubFriendshipService{}
	h := NewFriendshipHandler(svc, nil)

	rec := httptest.NewRecorder()
	h.SendRequest(rec, newSendFriendRequest(t, `{"username":"bob"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if !svc.sendCalled {
		t.Fatal("service should be called when no limiter is configured")
	}
}
