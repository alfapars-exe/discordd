package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"net/http/httptest"
	"testing"
)

type deletionStatusStub struct {
	calls  int
	owner  string
	offset int
	fail   bool
}

func (s *deletionStatusStub) Get(_ context.Context, owner string, offset int) (*models.AccountDeletionStatus, error) {
	s.calls++
	s.owner = owner
	s.offset = offset
	if s.fail {
		return nil, pkg.ErrInternal
	}
	return &models.AccountDeletionStatus{OwnedCount: 1, Resources: []models.AccountOwnedResource{{Kind: "server", ID: "owned", Name: "Owned"}}}, nil
}
func TestDeletionStatusOwnerScopeAndFailure(t *testing.T) {
	for _, tt := range []struct {
		name, query, sid string
		user             *models.User
		status, calls    int
		fail             bool
	}{
		{name: "anonymous", status: 401},
		{name: "bot", user: &models.User{ID: "a", IsBot: true}, sid: "actor", status: 403},
		{name: "missing session", user: &models.User{ID: "a"}, status: 401},
		{name: "wrong owner", user: &models.User{ID: "a"}, sid: "actor", query: "?expected_user_id=b", status: 409},
		{name: "bad page", user: &models.User{ID: "a"}, sid: "actor", query: "?expected_user_id=a&offset=-1", status: 400},
		{name: "failed read", user: &models.User{ID: "a"}, sid: "actor", query: "?expected_user_id=a", status: 500, calls: 1, fail: true},
		{name: "own page", user: &models.User{ID: "a"}, sid: "actor", query: "?expected_user_id=a&offset=50", status: 200, calls: 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			repo := &deletionStatusStub{fail: tt.fail}
			h := NewAccountDeletionStatusHandler(repo)
			req := httptest.NewRequest("GET", "/api/users/me/deletion-status"+tt.query, nil)
			ctx := context.WithValue(req.Context(), UserContextKey, tt.user)
			req = req.WithContext(context.WithValue(ctx, AuthSessionContextKey, tt.sid))
			w := httptest.NewRecorder()
			h.Get(w, req)
			if w.Code != tt.status || repo.calls != tt.calls {
				t.Fatalf("status %d calls %d: %s", w.Code, repo.calls, w.Body)
			}
			if repo.calls > 0 && repo.owner != "a" {
				t.Fatal("wrong owner queried")
			}
			if tt.name == "own page" && repo.offset != 50 {
				t.Fatal("offset lost")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("private preflight was cacheable")
			}
		})
	}
}
