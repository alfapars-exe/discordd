// UpdateProfile avatar-guard regression test. handlers/member.go:316 sets
// req.AvatarURL = nil right after decoding the PATCH /api/users/me/profile
// body, before it ever reaches MemberService. Nothing else pins that line:
// models.UpdateProfileRequest.Validate() never inspects AvatarURL, so without
// the guard a caller could point avatar_url at an arbitrary /api/uploads path
// — including someone else's orphaned private attachment — and launder it
// into MediaAssetRepository.IsPublicAsset's positive public-asset check
// (services/media_access_service.go), re-exposing a file the fail-closed
// Authorize rewrite was supposed to keep hidden. The only legitimate way to
// set an avatar is handlers/avatar.go, which calls MemberService.UpdateProfile
// directly and never goes through this JSON body.
//
// These tests exercise the handler (not models.UpdateProfileRequest.Validate
// in isolation) because the guard lives in the handler, not in Validate.
package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

// stubMemberService implements services.MemberService with the minimum
// needed to drive UpdateProfile: every other method is an unused no-op.
// UpdateProfile records the *models.UpdateProfileRequest exactly as it
// arrives from the handler, which is what the guard assertions inspect.
type stubMemberService struct {
	lastReq *models.UpdateProfileRequest
	result  *models.MemberWithRoles
	err     error
}

func (s *stubMemberService) GetAll(context.Context, string) ([]models.MemberWithRoles, error) {
	return nil, nil
}

func (s *stubMemberService) GetByID(context.Context, string, string) (*models.MemberWithRoles, error) {
	return nil, nil
}

func (s *stubMemberService) UpdateProfile(_ context.Context, _ string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error) {
	s.lastReq = req
	if s.err != nil {
		return nil, s.err
	}
	if s.result != nil {
		return s.result, nil
	}
	return &models.MemberWithRoles{}, nil
}

func (s *stubMemberService) UpdatePresence(context.Context, string, models.UserStatus) error {
	return nil
}

func (s *stubMemberService) ModifyRoles(context.Context, string, string, string, []string) (*models.MemberWithRoles, error) {
	return nil, nil
}

func (s *stubMemberService) Kick(context.Context, string, string, string) error { return nil }

func (s *stubMemberService) Ban(context.Context, string, string, string, string, *time.Time) error {
	return nil
}

func (s *stubMemberService) Unban(context.Context, string, string, string) error { return nil }

func (s *stubMemberService) GetBans(context.Context, string) ([]models.Ban, error) { return nil, nil }

func (s *stubMemberService) IsBanned(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s *stubMemberService) Timeout(context.Context, string, string, string, time.Time, string) error {
	return nil
}

func (s *stubMemberService) RemoveTimeout(context.Context, string, string, string) error {
	return nil
}

func (s *stubMemberService) IsTimedOut(context.Context, string, string) (*models.MemberTimeout, error) {
	return nil, nil
}

func (s *stubMemberService) SetNickname(context.Context, string, string, string, *string) (*models.MemberWithRoles, error) {
	return nil, nil
}

func (s *stubMemberService) SetAuditLogger(services.AuditWriter) {}

func (s *stubMemberService) SetPermInvalidator(services.PermissionInvalidator) {}

var _ services.MemberService = (*stubMemberService)(nil)

// newUpdateProfileRequest builds a PATCH /api/users/me/profile request with
// an authenticated caller in context, the way AuthMiddleware would leave it
// for the handler.
func newUpdateProfileRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/users/me/profile", bytes.NewBufferString(body))
	user := &models.User{ID: "user-1", Username: "tester"}
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
}

// TestUpdateProfile_AvatarURLGuard pins handlers/member.go:316
// (req.AvatarURL = nil). Delete that line and the first subtest below turns
// red: the stub would then observe the attacker-supplied avatar_url instead
// of nil.
func TestUpdateProfile_AvatarURLGuard(t *testing.T) {
	const body = `{"avatar_url":"/api/uploads/someone-elses-orphan.png","display_name":"New Name","custom_status":"brb"}`

	t.Run("avatar_url never reaches the service", func(t *testing.T) {
		// This is the assertion the guard exists for: with the guard removed,
		// stub.lastReq.AvatarURL would be a non-nil pointer to the attacker's
		// path instead of nil, and this check fails.
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		h.UpdateProfile(rec, newUpdateProfileRequest(t, body))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if stub.lastReq == nil {
			t.Fatal("service never received a request")
		}
		if stub.lastReq.AvatarURL != nil {
			t.Fatalf("AvatarURL leaked into the service request as %q — handlers/member.go's "+
				"req.AvatarURL = nil guard did not strip it", *stub.lastReq.AvatarURL)
		}
	})

	t.Run("sibling fields in the same body are untouched", func(t *testing.T) {
		// Control case: the guard must zero AvatarURL only, not the whole
		// request. If a future edit widened `req.AvatarURL = nil` into
		// `req = &models.UpdateProfileRequest{}` (or similar), this fails.
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		h.UpdateProfile(rec, newUpdateProfileRequest(t, body))

		if stub.lastReq == nil {
			t.Fatal("service never received a request")
		}
		if stub.lastReq.DisplayName == nil || *stub.lastReq.DisplayName != "New Name" {
			t.Errorf("DisplayName = %v, want pointer to \"New Name\"", stub.lastReq.DisplayName)
		}
		if stub.lastReq.CustomStatus == nil || *stub.lastReq.CustomStatus != "brb" {
			t.Errorf("CustomStatus = %v, want pointer to \"brb\"", stub.lastReq.CustomStatus)
		}
	})

	t.Run("avatar_url omitted from the body still arrives nil", func(t *testing.T) {
		// Consistency case: whether the client sends avatar_url or not, the
		// service must always see nil for it — there is no code path where
		// the JSON body can set an avatar.
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		h.UpdateProfile(rec, newUpdateProfileRequest(t, `{"display_name":"New Name"}`))

		if stub.lastReq == nil {
			t.Fatal("service never received a request")
		}
		if stub.lastReq.AvatarURL != nil {
			t.Fatalf("AvatarURL = %q, want nil when the field was never sent", *stub.lastReq.AvatarURL)
		}
	})
}
