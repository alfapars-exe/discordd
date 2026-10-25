package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type sessionBoundaryStub struct {
	services.AuthService
	active bool
	checks int
}

func (s *sessionBoundaryStub) ValidateAccessToken(string) (*models.TokenClaims, error) {
	return &models.TokenClaims{UserID: "owner", SessionID: "session-a"}, nil
}
func (s *sessionBoundaryStub) ValidateSession(_ context.Context, user, id string) error {
	s.checks++
	if user != "owner" || id != "session-a" || !s.active {
		return pkg.ErrUnauthorized
	}
	return nil
}

func TestSessionBoundaryIsCheckedEvenWithWarmUserCache(t *testing.T) {
	reads := 0
	auth := &sessionBoundaryStub{active: true}
	users := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) { reads++; return &models.User{ID: "owner"}, nil }}
	m := NewAuthMiddleware(auth, users, nil)
	handler := m.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Value(handlers.AuthSessionContextKey) != "session-a" {
			t.Error("missing bound session context")
		}
		w.WriteHeader(200)
	}))
	request := func() int {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", "Bearer test")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if status := request(); status != 200 {
		t.Fatalf("active=%d", status)
	}
	auth.active = false
	if status := request(); status != 401 {
		t.Fatalf("revoked=%d", status)
	}
	if auth.checks != 2 || reads != 1 {
		t.Fatalf("checks=%d user reads=%d", auth.checks, reads)
	}
}
