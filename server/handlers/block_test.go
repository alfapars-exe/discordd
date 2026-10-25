package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// stubBlockService records whether BlockUser reached the service so the
// rate-limit test can prove a 429 short-circuits before delegation.
type stubBlockService struct {
	blockCalled bool
}

func (s *stubBlockService) BlockUser(context.Context, string, string) error {
	s.blockCalled = true
	return nil
}
func (s *stubBlockService) UnblockUser(context.Context, string, string) error { return nil }
func (s *stubBlockService) ListBlocked(context.Context, string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubBlockService) IsBlocked(context.Context, string, string) (bool, error) {
	return false, nil
}

var _ services.BlockService = (*stubBlockService)(nil)

func TestBlockAccountMismatch(t *testing.T) {
	for _, action := range []string{"block", "unblock", "list"} {
		t.Run(action, func(t *testing.T) {
			svc := &stubBlockService{}
			h := NewBlockHandler(svc, nil)
			req := newBlockRequest(t)
			req.URL.RawQuery = "expected_user_id=another-account"
			rec := httptest.NewRecorder()
			switch action {
			case "block":
				h.BlockUser(rec, req)
			case "unblock":
				h.UnblockUser(rec, req)
			case "list":
				h.ListBlocked(rec, req)
			}
			if rec.Code != http.StatusConflict || svc.blockCalled {
				t.Fatalf("status=%d serviceCalled=%v", rec.Code, svc.blockCalled)
			}
		})
	}
}

func newBlockRequest(t *testing.T) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/users/user-2/block", nil)
	req.SetPathValue("userId", "user-2")
	// Inject an authenticated user — BlockUser() requires UserContextKey set.
	user := &models.User{ID: "user-1", Username: "tester"}
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
	return req
}

// TestBlockUser_RateLimit — POST /api/users/{userId}/block is rate-limited
// per user (Faz B, 2026-10-21): a block pushes user_block to both parties, so
// an unthrottled caller could spam a target. Requests within budget reach the
// service (204); once exhausted, the handler answers 429 with a Retry-After
// header and never calls the service for the rejected request.
func TestBlockUser_RateLimit(t *testing.T) {
	svc := &stubBlockService{}
	limiter := ratelimit.NewMessageRateLimiter(2, time.Minute, 30*time.Second)
	h := NewBlockHandler(svc, limiter)

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.BlockUser(rec, newBlockRequest(t))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("request %d: expected 204, got %d (body: %s)", i+1, rec.Code, rec.Body.String())
		}
	}
	if !svc.blockCalled {
		t.Fatal("BlockUser should have reached the service for in-budget requests")
	}

	svc.blockCalled = false
	rec := httptest.NewRecorder()
	h.BlockUser(rec, newBlockRequest(t))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 response")
	}
	if svc.blockCalled {
		t.Fatal("service must NOT be called once the rate limit is exceeded")
	}
}

// TestBlockUser_NilLimiterAllows — a nil limiter disables the check.
func TestBlockUser_NilLimiterAllows(t *testing.T) {
	svc := &stubBlockService{}
	h := NewBlockHandler(svc, nil)

	rec := httptest.NewRecorder()
	h.BlockUser(rec, newBlockRequest(t))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if !svc.blockCalled {
		t.Fatal("service should be called when no limiter is configured")
	}
}
