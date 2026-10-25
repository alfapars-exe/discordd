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

func TestMFALoginErrorsDoNotIssueCookiesOrTokens(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{{services.ErrMFARequired, 401, "MFA_REQUIRED"}, {services.ErrMFAInvalid, 401, "MFA_INVALID"}, {services.ErrMFARateLimited, 429, "MFA_RATE_LIMITED"}} {
		t.Run(tc.code, func(t *testing.T) {
			h := NewAuthHandler(&stubAuthService{loginFn: func(context.Context, *models.LoginRequest) (*services.AuthTokens, error) { return nil, tc.err }}, nil, nil, nil, nil, nil, nil)
			w := httptest.NewRecorder()
			h.Login(w, httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"username":"fixture","password":"password","mfa_code":"123456"}`)))
			if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.code) || len(w.Header().Values("Set-Cookie")) > 0 || strings.Contains(w.Body.String(), "access_token") {
				t.Fatalf("status=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
			}
			if tc.status == 429 && w.Header().Get("Retry-After") != "300" {
				t.Fatal("missing retry delay")
			}
		})
	}
}

func TestMFAManagementChecksOwnerBeforeService(t *testing.T) {
	h := NewAuthHandler(&stubAuthService{}, nil, nil, nil, nil, nil, nil)
	// A nil repository panics if touched. These requests must be rejected
	// at the boundary, before any secret, password or database operation.
	h.SetMFAService(services.NewMFAService(nil, nil, make([]byte, 32)))
	for _, tc := range []struct {
		user   *models.User
		body   string
		status int
	}{{nil, `{}`, 401}, {&models.User{ID: "a", IsBot: true}, `{"expected_user_id":"a"}`, 403}, {&models.User{ID: "a"}, `{"expected_user_id":"b"}`, 409}, {&models.User{ID: "a"}, `{"expected_user_id":"a","password":"` + strings.Repeat("x", 9000) + `"}`, 400}} {
		r := httptest.NewRequest("POST", "/api/users/me/mfa/setup", strings.NewReader(tc.body))
		r.SetPathValue("action", "setup")
		if tc.user != nil {
			r = r.WithContext(context.WithValue(r.Context(), UserContextKey, tc.user))
		}
		w := httptest.NewRecorder()
		h.MFAAction(w, r)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d expected=%d body=%s", w.Code, tc.status, w.Body.String())
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/users/me/mfa?expected_user_id=b", nil)
	r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "a"}))
	w := httptest.NewRecorder()
	h.MFAStatus(w, r)
	if w.Code != 409 {
		t.Fatal("status endpoint accepted wrong owner")
	}
}
