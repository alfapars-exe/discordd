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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

// stubMemberService implements services.MemberService with the minimum
// needed to drive UpdateProfile: every other method is an unused no-op.
// UpdateProfile records the *models.UpdateProfileRequest exactly as it
// arrives from the handler, which is what the guard assertions inspect.
type stubMemberService struct {
	lastReq *models.UpdateProfileRequest
	result  *models.MemberWithRoles
	err     error

	// Timeout capture/err — used by TestTimeoutHandler.
	timeoutServerID string
	timeoutActor    string
	timeoutTarget   string
	timeoutExpiry   time.Time
	timeoutReason   string
	timeoutCalled   bool
	timeoutErr      error

	// RemoveTimeout capture/err — used by TestRemoveTimeoutHandler.
	removeTimeoutCalled bool
	removeTimeoutErr    error

	// GetPublicProfile capture/result — used by TestGetUserProfileHandler.
	profileUserID string
	profile       *models.UserProfile
	profileErr    error
}

type stubProfileAudiencePolicy struct {
	allowed bool
	err     error
}

func (s stubProfileAudiencePolicy) CanView(context.Context, string, string) (bool, error) {
	return s.allowed, s.err
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

func (s *stubMemberService) GetPublicProfile(_ context.Context, userID string) (*models.UserProfile, error) {
	s.profileUserID = userID
	return s.profile, s.profileErr
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

func (s *stubMemberService) Timeout(_ context.Context, serverID, actorID, targetID string, expiresAt time.Time, reason string) error {
	s.timeoutCalled = true
	s.timeoutServerID = serverID
	s.timeoutActor = actorID
	s.timeoutTarget = targetID
	s.timeoutExpiry = expiresAt
	s.timeoutReason = reason
	return s.timeoutErr
}

func (s *stubMemberService) RemoveTimeout(context.Context, string, string, string) error {
	s.removeTimeoutCalled = true
	return s.removeTimeoutErr
}

func (s *stubMemberService) IsTimedOut(context.Context, string, string) (*models.MemberTimeout, error) {
	return nil, nil
}

func (s *stubMemberService) SetNickname(context.Context, string, string, string, *string) (*models.MemberWithRoles, error) {
	return nil, nil
}

func (s *stubMemberService) SetPermInvalidator(services.PermissionInvalidator)     {}
func (s *stubMemberService) SetUserCacheInvalidator(services.UserCacheInvalidator) {}

var _ services.MemberService = (*stubMemberService)(nil)

// newModerationRequest builds a request carrying an authenticated actor and
// (optionally) a server context, mirroring what the auth -> authServer ->
// authServerPerm middleware chain leaves in place for a server-scoped
// member moderation route. targetID, if non-empty, is set as the "id" path
// value (routes are /api/servers/{serverId}/members/{id}/...).
func newModerationRequest(method, path, body, serverID, targetID string) *http.Request {
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, bytes.NewBufferString(body))
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	actor := &models.User{ID: "mod-1", Username: "mod"}
	ctx := context.WithValue(req.Context(), UserContextKey, actor)
	if serverID != "" {
		ctx = context.WithValue(ctx, ServerIDContextKey, serverID)
	}
	req = req.WithContext(ctx)
	if targetID != "" {
		req.SetPathValue("id", targetID)
	}
	return req
}

// TestTimeoutHandler exercises PUT /api/servers/{serverId}/members/{id}/timeout.
func TestTimeoutHandler(t *testing.T) {
	t.Run("success — 200 and the service receives the decoded/expanded args", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		before := time.Now().UTC()
		req := newModerationRequest(http.MethodPut, "/api/servers/srv1/members/victim1/timeout",
			`{"duration_seconds":300,"reason":"spam"}`, "srv1", "victim1")
		h.Timeout(rec, req)
		after := time.Now().UTC()

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if !stub.timeoutCalled {
			t.Fatal("expected the service's Timeout to be called")
		}
		if stub.timeoutServerID != "srv1" || stub.timeoutActor != "mod-1" || stub.timeoutTarget != "victim1" {
			t.Errorf("unexpected args: server=%q actor=%q target=%q",
				stub.timeoutServerID, stub.timeoutActor, stub.timeoutTarget)
		}
		if stub.timeoutReason != "spam" {
			t.Errorf("reason = %q, want %q", stub.timeoutReason, "spam")
		}
		wantMin := before.Add(300 * time.Second)
		wantMax := after.Add(300 * time.Second)
		if stub.timeoutExpiry.Before(wantMin) || stub.timeoutExpiry.After(wantMax) {
			t.Errorf("expiry = %v, want between %v and %v", stub.timeoutExpiry, wantMin, wantMax)
		}
	})

	t.Run("malformed JSON body — 400, service not called", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodPut, "/api/servers/srv1/members/victim1/timeout",
			`{not valid json`, "srv1", "victim1")
		h.Timeout(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
		if stub.timeoutCalled {
			t.Error("service must not be called for a malformed body")
		}
	})

	t.Run("zero duration fails Validate — 400, service not called", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodPut, "/api/servers/srv1/members/victim1/timeout",
			`{"duration_seconds":0,"reason":""}`, "srv1", "victim1")
		h.Timeout(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
		if stub.timeoutCalled {
			t.Error("service must not be called when duration fails validation")
		}
	})

	t.Run("duration over 28 days fails Validate — 400, service not called", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		const overCap = 28*24*60*60 + 1
		req := newModerationRequest(http.MethodPut, "/api/servers/srv1/members/victim1/timeout",
			`{"duration_seconds":`+strconv.Itoa(overCap)+`,"reason":""}`, "srv1", "victim1")
		h.Timeout(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
		if stub.timeoutCalled {
			t.Error("service must not be called when duration exceeds the 28-day cap")
		}
	})

	t.Run("service returns ErrForbidden — 403", func(t *testing.T) {
		stub := &stubMemberService{timeoutErr: pkg.ErrForbidden}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodPut, "/api/servers/srv1/members/victim1/timeout",
			`{"duration_seconds":60,"reason":""}`, "srv1", "victim1")
		h.Timeout(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403 (body %q)", rec.Code, rec.Body.String())
		}
	})

	t.Run("missing server context — 400", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodPut, "/api/servers//members/victim1/timeout",
			`{"duration_seconds":60,"reason":""}`, "", "victim1")
		h.Timeout(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
		if stub.timeoutCalled {
			t.Error("service must not be called without a server context")
		}
	})
}

// TestRemoveTimeoutHandler exercises DELETE /api/servers/{serverId}/members/{id}/timeout.
func TestRemoveTimeoutHandler(t *testing.T) {
	t.Run("success — 200", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodDelete, "/api/servers/srv1/members/victim1/timeout",
			"", "srv1", "victim1")
		h.RemoveTimeout(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if !stub.removeTimeoutCalled {
			t.Error("expected the service's RemoveTimeout to be called")
		}
	})

	t.Run("missing id path value — 400, service not called", func(t *testing.T) {
		stub := &stubMemberService{}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodDelete, "/api/servers/srv1/members//timeout",
			"", "srv1", "")
		h.RemoveTimeout(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
		if stub.removeTimeoutCalled {
			t.Error("service must not be called without a target id")
		}
	})

	t.Run("service error passthrough — 403", func(t *testing.T) {
		stub := &stubMemberService{removeTimeoutErr: pkg.ErrForbidden}
		h := NewMemberHandler(stub)
		rec := httptest.NewRecorder()

		req := newModerationRequest(http.MethodDelete, "/api/servers/srv1/members/victim1/timeout",
			"", "srv1", "victim1")
		h.RemoveTimeout(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403 (body %q)", rec.Code, rec.Body.String())
		}
	})
}

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

// TestUpdateProfile_MediaFieldGuard extends the avatar_url guard to the
// migration-085 media fields: a PATCH body naming avatar_animated_url,
// banner_url or clear_banner must never reach the service with them set,
// while the user-written profile fields in the same body pass through.
func TestUpdateProfile_MediaFieldGuard(t *testing.T) {
	const body = `{"avatar_animated_url":"/api/uploads/orphan.gif","banner_url":"/api/uploads/orphan.png",` +
		`"clear_banner":true,"bio":"hello","pronouns":"she/her","accent_color":"#ABCDEF"}`
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
	if stub.lastReq.AvatarAnimatedURL != nil || stub.lastReq.BannerURL != nil || stub.lastReq.ClearBanner {
		t.Fatalf("media fields leaked into the service request: animated=%v banner=%v clear=%v",
			stub.lastReq.AvatarAnimatedURL, stub.lastReq.BannerURL, stub.lastReq.ClearBanner)
	}
	if stub.lastReq.Bio == nil || *stub.lastReq.Bio != "hello" ||
		stub.lastReq.Pronouns == nil || *stub.lastReq.Pronouns != "she/her" ||
		stub.lastReq.AccentColor == nil || *stub.lastReq.AccentColor != "#ABCDEF" {
		t.Errorf("profile text fields not passed through: %+v", stub.lastReq)
	}
}

// newRealMemberHandler wires MemberHandler to the REAL services.MemberService
// over testutil mocks (handlers/saved_test.go pattern), so Validate and the
// nil / "" / value PATCH semantics run for real. Returns the handler and a
// pointer to the last user row the service wrote.
func newRealMemberHandler(t *testing.T, current *models.User) (*MemberHandler, **models.User) {
	t.Helper()
	var written *models.User
	users := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			if id != current.ID {
				return nil, pkg.ErrNotFound
			}
			cp := *current
			return &cp, nil
		},
		UpdateFn: func(_ context.Context, u *models.User) error {
			written = u
			return nil
		},
	}
	svc := services.NewMemberService(users, nil, nil, nil, &testutil.MockServerRepo{},
		&testutil.MockEventPublisher{}, nil, nil)
	return NewMemberHandler(svc), &written
}

func TestUpdateProfile_ProfileFields_RealService(t *testing.T) {
	oldBio := "old bio"
	oldAccent := "#000000"
	current := &models.User{ID: "user-1", Username: "tester", Bio: &oldBio, AccentColor: &oldAccent}

	t.Run("191-rune bio is 400 through models.Validate", func(t *testing.T) {
		h, written := newRealMemberHandler(t, current)
		rec := httptest.NewRecorder()
		body := `{"bio":"` + strings.Repeat("x", models.BioMaxRunes+1) + `"}`
		h.UpdateProfile(rec, newUpdateProfileRequest(t, body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
		}
		if *written != nil {
			t.Fatal("user row written despite validation failure")
		}
	})

	t.Run("invalid accent colour is 400", func(t *testing.T) {
		h, _ := newRealMemberHandler(t, current)
		rec := httptest.NewRecorder()
		h.UpdateProfile(rec, newUpdateProfileRequest(t, `{"accent_color":"red"}`))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("set, clear and keep", func(t *testing.T) {
		h, written := newRealMemberHandler(t, current)
		rec := httptest.NewRecorder()
		// pronouns set (trimmed), bio cleared with "", accent_color omitted (kept).
		h.UpdateProfile(rec, newUpdateProfileRequest(t, `{"pronouns":"  they/them ","bio":""}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		u := *written
		if u == nil {
			t.Fatal("user row never written")
		}
		if u.Pronouns == nil || *u.Pronouns != "they/them" {
			t.Errorf("Pronouns = %v, want they/them", u.Pronouns)
		}
		if u.Bio != nil {
			t.Errorf("Bio = %q, want nil (cleared)", *u.Bio)
		}
		if u.AccentColor == nil || *u.AccentColor != oldAccent {
			t.Errorf("AccentColor = %v, want unchanged %s", u.AccentColor, oldAccent)
		}
		var resp models.MemberWithRoles
		decodeEnvelope(t, rec, &resp)
		if resp.Pronouns == nil || *resp.Pronouns != "they/them" || resp.Bio != nil {
			t.Errorf("response profile fields = pronouns %v bio %v", resp.Pronouns, resp.Bio)
		}
	})
}

func TestGetUserProfileHandler(t *testing.T) {
	newReq := func(userID string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/users/"+userID+"/profile", nil)
		req.SetPathValue("userId", userID)
		return req
	}

	t.Run("200 with the profile", func(t *testing.T) {
		bio := "hi"
		stub := &stubMemberService{profile: &models.UserProfile{ID: "u-2", Username: "bob", Bio: &bio}}
		rec := httptest.NewRecorder()
		NewMemberHandler(stub).GetUserProfile(rec, newReq("u-2"))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if stub.profileUserID != "u-2" {
			t.Errorf("service got user id %q, want u-2", stub.profileUserID)
		}
		var got models.UserProfile
		decodeEnvelope(t, rec, &got)
		if got.ID != "u-2" || got.Bio == nil || *got.Bio != "hi" {
			t.Errorf("profile = %+v", got)
		}
	})

	t.Run("404 for an unknown user", func(t *testing.T) {
		stub := &stubMemberService{profileErr: pkg.ErrNotFound}
		rec := httptest.NewRecorder()
		NewMemberHandler(stub).GetUserProfile(rec, newReq("ghost"))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("404 when the target profile audience denies the viewer", func(t *testing.T) {
		stub := &stubMemberService{profile: &models.UserProfile{ID: "u-2", Username: "bob"}}
		req := newReq("u-2")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "u-1"}))
		rec := httptest.NewRecorder()
		NewMemberHandler(stub, stubProfileAudiencePolicy{allowed: false}).GetUserProfile(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		if stub.profileUserID != "" {
			t.Fatalf("profile service was called for denied viewer")
		}
	})

	t.Run("loads profile after audience allows the viewer", func(t *testing.T) {
		stub := &stubMemberService{profile: &models.UserProfile{ID: "u-2", Username: "bob"}}
		req := newReq("u-2")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "u-1"}))
		rec := httptest.NewRecorder()
		NewMemberHandler(stub, stubProfileAudiencePolicy{allowed: true}).GetUserProfile(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
	})

	t.Run("400 without a user id", func(t *testing.T) {
		stub := &stubMemberService{}
		rec := httptest.NewRecorder()
		NewMemberHandler(stub).GetUserProfile(rec, httptest.NewRequest(http.MethodGet, "/api/users//profile", nil))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}
