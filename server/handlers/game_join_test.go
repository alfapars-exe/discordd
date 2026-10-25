package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

type joinHTTPAuth struct {
	services.AuthService
	claims   models.TokenClaims
	calls    int
	revokeAt int
}

func (a *joinHTTPAuth) ValidateAccessToken(token string) (*models.TokenClaims, error) {
	if token != "synthetic-access" {
		return nil, pkg.ErrUnauthorized
	}
	return &a.claims, nil
}
func (a *joinHTTPAuth) ValidateSession(context.Context, string, string) error {
	a.calls++
	if a.revokeAt > 0 && a.calls >= a.revokeAt {
		return pkg.ErrUnauthorized
	}
	return nil
}

type joinHTTPUsers struct {
	repository.UserRepository
	user models.User
}

func (u *joinHTTPUsers) GetByID(context.Context, string) (*models.User, error) { return &u.user, nil }

type joinHTTPLifecycle struct {
	repository.AccountLifecycleRepository
	state models.AccountLifecycle
}

func (l *joinHTTPLifecycle) Get(context.Context, string) (*models.AccountLifecycle, error) {
	return &l.state, nil
}

// HTTP admission uses real handler/service paths; no recipe can be exposed by
// malformed input, another account, a bot, or a revoked physical session.
func TestGameJoinHTTPAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		mutate     func(*joinHTTPAuth, *joinHTTPUsers, *joinHTTPLifecycle)
	}{
		{"unknown ticket", `{"expected_user_id":"viewer","ticket":"` + strings.Repeat("a", 43) + `"}`, 404, nil},
		{"account mismatch", `{"expected_user_id":"other","ticket":"missing"}`, 409, nil},
		{"unknown launch URL field", `{"expected_user_id":"viewer","ticket":"missing","url":"steam://run/730"}`, 400, nil},
		{"trailing JSON", `{"expected_user_id":"viewer","ticket":"missing"} {}`, 400, nil},
		{"bot", `{}`, 401, func(_ *joinHTTPAuth, u *joinHTTPUsers, _ *joinHTTPLifecycle) { u.user.IsBot = true }},
		{"revoked session", `{}`, 401, func(a *joinHTTPAuth, _ *joinHTTPUsers, _ *joinHTTPLifecycle) { a.revokeAt = 1 }},
		{"changed token version", `{}`, 401, func(_ *joinHTTPAuth, u *joinHTTPUsers, _ *joinHTTPLifecycle) { u.user.TokenVersion = 1 }},
		{"media scope", `{}`, 401, func(a *joinHTTPAuth, _ *joinHTTPUsers, _ *joinHTTPLifecycle) { a.claims.Scope = models.TokenScopeMedia }},
		{"disabled", `{}`, 401, func(_ *joinHTTPAuth, _ *joinHTTPUsers, l *joinHTTPLifecycle) {
			at := int64(1)
			l.state.DisabledAt = &at
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &joinHTTPAuth{claims: models.TokenClaims{UserID: "viewer", SessionID: "session"}}
			u := &joinHTTPUsers{user: models.User{ID: "viewer"}}
			l := &joinHTTPLifecycle{}
			if tc.mutate != nil {
				tc.mutate(a, u, l)
			}
			h := NewGameJoinHandler(services.NewGameJoinService(nil, nil), a, u, l)
			r := httptest.NewRequest(http.MethodPost, "/api/game-join/tickets/consume", strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer synthetic-access")
			w := httptest.NewRecorder()
			h.Consume(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d", w.Code, tc.status)
			}
			if strings.Contains(w.Body.String(), "recipe") {
				t.Fatal("denied response exposed recipe")
			}
		})
	}
}

func TestGameJoinTargetsRecheckSessionBeforeResponse(t *testing.T) {
	a := &joinHTTPAuth{claims: models.TokenClaims{UserID: "viewer", SessionID: "session"}, revokeAt: 2}
	h := NewGameJoinHandler(services.NewGameJoinService(nil, nil), a, &joinHTTPUsers{user: models.User{ID: "viewer"}}, &joinHTTPLifecycle{})
	r := httptest.NewRequest(http.MethodPost, "/api/game-join/targets", strings.NewReader(`{"expected_user_id":"viewer","targets":[{"target_user_id":"host","context":"friend"}]}`))
	r.Header.Set("Authorization", "Bearer synthetic-access")
	w := httptest.NewRecorder()
	h.Targets(w, r)
	if w.Code != http.StatusUnauthorized || a.calls != 2 {
		t.Fatalf("revoked late session: status=%d checks=%d", w.Code, a.calls)
	}
}
