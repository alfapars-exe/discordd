package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type lifecycleAuthStub struct {
	*stubAuthService
	calls      int
	owner, sid string
}

func (s *lifecycleAuthStub) DisableAccount(_ context.Context, owner, sid, _, _ string) error {
	s.calls++
	s.owner = owner
	s.sid = sid
	return nil
}
func TestDisableAccountHandlerScopeConfirmationAndCookies(t *testing.T) {
	for _, test := range []struct {
		name, body  string
		user        *models.User
		sid         string
		code, calls int
	}{
		{name: "missing auth", body: `{}`, code: 401},
		{name: "bot", body: `{}`, user: &models.User{ID: "a", IsBot: true}, sid: "own", code: 403},
		{name: "missing session", body: `{}`, user: &models.User{ID: "a"}, code: 401},
		{name: "wrong owner", body: `{"expected_user_id":"b","password":"p","confirm":true}`, user: &models.User{ID: "a"}, sid: "own", code: 409},
		{name: "missing confirmation", body: `{"expected_user_id":"a","password":"p"}`, user: &models.User{ID: "a"}, sid: "own", code: 400},
		{name: "extra JSON", body: `{} {}`, user: &models.User{ID: "a"}, sid: "own", code: 400},
		{name: "too large", body: `{"password":"` + strings.Repeat("x", 9000) + `"}`, user: &models.User{ID: "a"}, sid: "own", code: 400},
		{name: "confirmed", body: `{"expected_user_id":"a","password":"p","confirm":true}`, user: &models.User{ID: "a"}, sid: "own", code: 200, calls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &lifecycleAuthStub{stubAuthService: &stubAuthService{}}
			h := NewAuthHandler(s, nil, nil, nil, nil, nil, nil)
			r := httptest.NewRequest("POST", "/api/users/me/disable", strings.NewReader(test.body))
			ctx := context.WithValue(r.Context(), UserContextKey, test.user)
			ctx = context.WithValue(ctx, AuthSessionContextKey, test.sid)
			r = r.WithContext(ctx)
			r.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "unrelated-session"}) // not the action's owner
			w := httptest.NewRecorder()
			h.DisableAccount(w, r)
			if w.Code != test.code || s.calls != test.calls {
				t.Fatalf("status %d calls %d body %s", w.Code, s.calls, w.Body)
			}
			if s.calls > 0 && (s.owner != "a" || s.sid != "own") {
				t.Fatal("wrong owner/session used")
			}
			if len(w.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("late disable cleared shared cookies")
			}
		})
	}
}
func TestDisabledLoginDoesNotIssueCookiesOrTokens(t *testing.T) {
	h := NewAuthHandler(&stubAuthService{loginFn: func(_ context.Context, r *models.LoginRequest) (*services.AuthTokens, error) {
		if r.Reactivate {
			t.Fatal("normal login invented restore consent")
		}
		return nil, services.ErrAccountDisabled
	}}, nil, nil, nil, nil, nil, nil)
	w := httptest.NewRecorder()
	h.Login(w, httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"username":"fixture","password":"password"}`)))
	if w.Code != 403 || !strings.Contains(w.Body.String(), "ACCOUNT_DISABLED") || strings.Contains(w.Body.String(), "access_token") || len(w.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("disabled login response %d %s", w.Code, w.Body)
	}
}
