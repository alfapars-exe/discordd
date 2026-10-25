package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEmailVerificationOwnerAndBounds(t *testing.T) {
	h := NewEmailVerificationHandler(services.NewEmailVerificationService(nil, nil), nil)
	for _, test := range []struct {
		body   string
		user   *models.User
		status int
	}{
		{body: `{}`, status: 401},
		{body: `{}`, user: &models.User{ID: "a", IsBot: true}, status: 403},
		{body: `{"expected_user_id":"b","generation":0}`, user: &models.User{ID: "a"}, status: 409},
		{body: `{"expected_user_id":"a"}`, user: &models.User{ID: "a"}, status: 400},
		{body: `{} {}`, user: &models.User{ID: "a"}, status: 400},
		{body: `{"x":"` + strings.Repeat("x", 5000) + `"}`, user: &models.User{ID: "a"}, status: 400},
		{body: `{"expected_user_id":"a","generation":0}`, user: &models.User{ID: "a"}, status: 503},
	} {
		r := httptest.NewRequest("POST", "/api/users/me/email-verification", strings.NewReader(test.body))
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, test.user))
		w := httptest.NewRecorder()
		h.Request(w, r)
		if w.Code != test.status || w.Header().Get("Cache-Control") != "no-store" || len(w.Header().Values("Set-Cookie")) != 0 {
			t.Fatalf("status %d expected %d body %s", w.Code, test.status, w.Body)
		}
	}
}
func TestEmailVerificationPublicProofLimits(t *testing.T) {
	h := NewEmailVerificationHandler(services.NewEmailVerificationService(nil, nil), ratelimit.NewLoginRateLimiter(2, time.Minute))
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("POST", "/api/auth/verify-email", strings.NewReader(`{"token":"malformed"}`))
		w := httptest.NewRecorder()
		h.Verify(w, r)
		want := 400
		if i == 2 {
			want = 429
		}
		if w.Code != want || strings.Contains(w.Body.String(), "access_token") || len(w.Header().Values("Set-Cookie")) != 0 {
			t.Fatalf("status %d want %d body %s", w.Code, want, w.Body)
		}
	}
}
