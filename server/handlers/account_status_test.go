package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"net/http/httptest"
	"strings"
	"testing"
)

type accountStatusFixture struct {
	calls int
	owner string
	err   error
}

func (f *accountStatusFixture) Get(_ context.Context, owner string, offset int) (*models.AccountStatus, error) {
	f.calls++
	f.owner = owner
	return &models.AccountStatus{Restrictions: []models.AccountRestriction{{Kind: "ban", ServerName: "Actual server", Reason: "Actual reason"}}}, f.err
}
func TestAccountStatusHandlerOwnerAndFailures(t *testing.T) {
	for _, test := range []struct {
		name, query string
		user        *models.User
		failure     error
		code, calls int
	}{
		{name: "unauthenticated", code: 401},
		{name: "nil user", user: nil, code: 401},
		{name: "bot", query: "expected_user_id=a", user: &models.User{ID: "a", IsBot: true}, code: 403},
		{name: "missing affinity", user: &models.User{ID: "a"}, code: 409},
		{name: "mismatch", query: "expected_user_id=b", user: &models.User{ID: "a"}, code: 409},
		{name: "bad offset", query: "expected_user_id=a&offset=-1", user: &models.User{ID: "a"}, code: 400},
		{name: "wrong owner parameter ignored", query: "expected_user_id=a&user_id=b", user: &models.User{ID: "a"}, code: 200, calls: 1},
		{name: "database failure", query: "expected_user_id=a", user: &models.User{ID: "a"}, failure: pkg.ErrInternal, code: 500, calls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := &accountStatusFixture{err: test.failure}
			h := NewAccountStatusHandler(f)
			r := httptest.NewRequest("GET", "/api/users/me/account-status?"+test.query, nil)
			r = r.WithContext(context.WithValue(r.Context(), UserContextKey, test.user))
			w := httptest.NewRecorder()
			h.Get(w, r)
			if w.Code != test.code || f.calls != test.calls {
				t.Fatalf("status %d calls %d body %s", w.Code, f.calls, w.Body)
			}
			if f.calls > 0 && f.owner != "a" {
				t.Fatal("read a different owner")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("moderation response cacheable")
			}
			if test.failure != nil && strings.Contains(w.Body.String(), "Actual server") {
				t.Fatal("error returned healthy/private snapshot")
			}
		})
	}
}
