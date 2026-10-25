package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

func TestCredentialChangesAccountAffinity(t *testing.T) {
	for _, endpoint := range []string{"email", "password"} {
		for _, expected := range []string{"account-a", "account-b", ""} {
			t.Run(endpoint+"/"+expected, func(t *testing.T) {
				calls := 0
				change := func(_ context.Context, id, _, _ string) error {
					calls++
					if id != "account-a" {
						t.Fatalf("wrong owner: %s", id)
					}
					return nil
				}
				svc := &stubAuthService{changePasswordFn: change, changeEmailFn: change}
				h := NewAuthHandler(svc, nil, nil, nil, nil, nil, nil)
				body := `{"expected_user_id":"` + expected + `","password":"current","new_email":"","current_password":"current","new_password":"new-password"}`
				r := httptest.NewRequest(http.MethodPost, "/api/users/me/"+endpoint, strings.NewReader(body))
				r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "account-a"}))
				w := httptest.NewRecorder()
				if endpoint == "email" {
					h.ChangeEmail(w, r)
				} else {
					h.ChangePassword(w, r)
				}
				if expected == "account-b" {
					if w.Code != http.StatusConflict || calls != 0 || !strings.Contains(w.Body.String(), `"ACCOUNT_MISMATCH"`) {
						t.Fatalf("mismatch must not mutate: %d calls=%d %s", w.Code, calls, w.Body.String())
					}
				} else if w.Code != http.StatusOK || calls != 1 {
					t.Fatalf("compatible request: %d calls=%d %s", w.Code, calls, w.Body.String())
				}
			})
		}
	}
}

func TestCookieAccountMismatchDoesNotClearOrRotateCookies(t *testing.T) {
	svc := &stubAuthService{
		refreshTokenFn: func(context.Context, string) (*services.AuthTokens, error) {
			return nil, services.ErrAuthAccountMismatch
		},
		logoutFn: func(context.Context, string) error { return services.ErrAuthAccountMismatch },
	}
	h := NewAuthHandler(svc, nil, nil, nil, nil, nil, nil)
	for _, handler := range []http.HandlerFunc{h.Refresh, h.Logout} {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", strings.NewReader(`{"refresh_token":"cookie-b","expected_user_id":"a"}`))
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Code != http.StatusConflict || len(w.Header().Values("Set-Cookie")) != 0 || !strings.Contains(w.Body.String(), `"ACCOUNT_MISMATCH"`) {
			t.Fatalf("must leave other account's cookies untouched: %d %v %s", w.Code, w.Header(), w.Body.String())
		}
	}
}

func TestCredentialChangesRejectNilContextUser(t *testing.T) {
	h := NewAuthHandler(&stubAuthService{}, nil, nil, nil, nil, nil, nil)
	for _, handler := range []http.HandlerFunc{h.ChangeEmail, h.ChangePassword} {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, (*models.User)(nil)))
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("nil user: %d", w.Code)
		}
	}
}
