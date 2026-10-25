package handlers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

type profileGuardShowcaseService struct{ calls int }

func (s *profileGuardShowcaseService) Get(context.Context, string, string) (*models.ProfileShowcase, error) {
	s.calls++
	return &models.ProfileShowcase{}, nil
}
func (*profileGuardShowcaseService) GetPublic(context.Context, string, string, string) (*models.ProfileShowcase, error) {
	return &models.ProfileShowcase{}, nil
}
func (s *profileGuardShowcaseService) Put(context.Context, string, string, *models.ProfileShowcase, int64) (*models.ProfileShowcase, error) {
	s.calls++
	return &models.ProfileShowcase{}, nil
}

func profileGuardRequest(method, path string, body io.ReadCloser, user *models.User) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	if body != nil {
		req.Body = body
	}
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
}

func requireProfileMismatch(t *testing.T, rec *httptest.ResponseRecorder, calls int) {
	t.Helper()
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"PROFILE_ACCOUNT_MISMATCH"`) || calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s, want 409 PROFILE_ACCOUNT_MISMATCH and no calls", rec.Code, calls, rec.Body.String())
	}
}

func TestProfileEndpointsRejectAccountMismatchBeforeBodyOrSideEffects(t *testing.T) {
	memberSvc := &stubMemberService{}
	showcaseSvc := &profileGuardShowcaseService{}
	memberHandler := NewMemberHandler(memberSvc)
	avatarHandler := &AvatarHandler{}
	showcaseHandler := NewProfileShowcaseHandler(showcaseSvc)
	body := func() *accountGuardBody { return &accountGuardBody{reader: strings.NewReader("{")} }

	tests := []struct {
		name   string
		method string
		path   string
		body   *accountGuardBody
		handle func(http.ResponseWriter, *http.Request)
		calls  func() int
	}{
		{"update profile", http.MethodPatch, "/api/users/me/profile?expected_user_id=old", body(), memberHandler.UpdateProfile, func() int { return boolToInt(memberSvc.lastReq != nil) }},
		{"upload avatar", http.MethodPost, "/api/users/me/avatar?expected_user_id=old", body(), avatarHandler.UploadUserAvatar, func() int { return 0 }},
		{"upload banner", http.MethodPost, "/api/users/me/banner?expected_user_id=old", body(), avatarHandler.UploadUserBanner, func() int { return 0 }},
		{"delete banner", http.MethodDelete, "/api/users/me/banner?expected_user_id=old", nil, avatarHandler.DeleteUserBanner, func() int { return 0 }},
		{"get showcase", http.MethodGet, "/api/users/me/profile-showcase?expected_user_id=old", nil, showcaseHandler.Get, func() int { return showcaseSvc.calls }},
		{"put showcase", http.MethodPut, "/api/users/me/profile-showcase?expected_user_id=old", body(), showcaseHandler.Put, func() int { return showcaseSvc.calls }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if test.name == "update profile" {
				memberSvc.lastReq = nil
			}
			if test.name == "get showcase" || test.name == "put showcase" {
				showcaseSvc.calls = 0
			}
			req := profileGuardRequest(test.method, test.path, test.body, &models.User{ID: "current"})
			rec := httptest.NewRecorder()
			test.handle(rec, req)
			requireProfileMismatch(t, rec, test.calls())
			if test.body != nil && test.body.reads != 0 {
				t.Fatalf("request body read %d times before account mismatch", test.body.reads)
			}
		})
	}
}

func TestProfileEndpointsRejectTypedNilUser(t *testing.T) {
	memberHandler := NewMemberHandler(&stubMemberService{})
	avatarHandler := &AvatarHandler{}
	showcaseSvc := &profileGuardShowcaseService{}
	showcaseHandler := NewProfileShowcaseHandler(showcaseSvc)
	var nilUser *models.User
	tests := []struct {
		name   string
		method string
		path   string
		handle func(http.ResponseWriter, *http.Request)
	}{
		{"update profile", http.MethodPatch, "/api/users/me/profile?expected_user_id=current", memberHandler.UpdateProfile},
		{"upload avatar", http.MethodPost, "/api/users/me/avatar?expected_user_id=current", avatarHandler.UploadUserAvatar},
		{"upload banner", http.MethodPost, "/api/users/me/banner?expected_user_id=current", avatarHandler.UploadUserBanner},
		{"delete banner", http.MethodDelete, "/api/users/me/banner?expected_user_id=current", avatarHandler.DeleteUserBanner},
		{"get showcase", http.MethodGet, "/api/users/me/profile-showcase?expected_user_id=current", showcaseHandler.Get},
		{"put showcase", http.MethodPut, "/api/users/me/profile-showcase?expected_user_id=current", showcaseHandler.Put},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := profileGuardRequest(test.method, test.path, nil, nilUser)
			rec := httptest.NewRecorder()
			test.handle(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s, want 401", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestProfileAccountGuardAllowsOmittedExpectedUserID(t *testing.T) {
	memberSvc := &stubMemberService{}
	showcaseSvc := &profileGuardShowcaseService{}
	memberHandler := NewMemberHandler(memberSvc)
	showcaseHandler := NewProfileShowcaseHandler(showcaseSvc)

	update := profileGuardRequest(http.MethodPatch, "/api/users/me/profile", io.NopCloser(strings.NewReader(`{}`)), &models.User{ID: "current"})
	updateRec := httptest.NewRecorder()
	memberHandler.UpdateProfile(updateRec, update)
	if updateRec.Code != http.StatusOK || memberSvc.lastReq == nil {
		t.Fatalf("update without expected_user_id: status=%d body=%s serviceCalled=%v", updateRec.Code, updateRec.Body.String(), memberSvc.lastReq != nil)
	}

	showcase := profileGuardRequest(http.MethodGet, "/api/users/me/profile-showcase", nil, &models.User{ID: "current"})
	showcaseRec := httptest.NewRecorder()
	showcaseHandler.Get(showcaseRec, showcase)
	if showcaseRec.Code != http.StatusOK || showcaseSvc.calls != 1 {
		t.Fatalf("showcase without expected_user_id: status=%d body=%s serviceCalls=%d", showcaseRec.Code, showcaseRec.Body.String(), showcaseSvc.calls)
	}

	put := profileGuardRequest(http.MethodPut, "/api/users/me/profile-showcase", io.NopCloser(strings.NewReader(`{"expected_version":0,"showcase":{}}`)), &models.User{ID: "current"})
	putRec := httptest.NewRecorder()
	showcaseHandler.Put(putRec, put)
	if putRec.Code != http.StatusOK || showcaseSvc.calls != 2 {
		t.Fatalf("showcase put without expected_user_id: status=%d body=%s serviceCalls=%d", putRec.Code, putRec.Body.String(), showcaseSvc.calls)
	}
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

var _ services.ProfileShowcaseService = (*profileGuardShowcaseService)(nil)
