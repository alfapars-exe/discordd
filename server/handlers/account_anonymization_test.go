package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"net/http/httptest"
	"strings"
	"testing"
)

type deletingAuthStub struct {
	*stubAuthService
	calls      int
	err        error
	owner, sid string
}

func (s *deletingAuthStub) DeleteAccount(_ context.Context, owner, sid, _, _ string) error {
	s.calls++
	s.owner = owner
	s.sid = sid
	return s.err
}
func TestDeleteAccountExplicitConsentAndAffinity(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		code       int
		called     bool
		err        error
	}{
		{name: "no typed consent", body: `{"expected_user_id":"a","password":"p","confirm":true}`, code: 400},
		{name: "wrong account", body: `{"expected_user_id":"b","password":"p","confirm":true,"confirm_text":"DELETE"}`, code: 409},
		{name: "no separate confirmation", body: `{"expected_user_id":"a","password":"p","confirm_text":"DELETE"}`, code: 400},
		{name: "unknown field", body: `{"expected_user_id":"a","extra":true}`, code: 400},
		{name: "extra json", body: `{} {}`, code: 400},
		{name: "bounded", body: `{"password":"` + strings.Repeat("x", 9000) + `"}`, code: 400},
		{name: "owned server", body: `{"expected_user_id":"a","password":"p","confirm":true,"confirm_text":"DELETE"}`, code: 409, called: true, err: repository.ErrDeletionOwnsServers},
		{name: "confirmed", body: `{"expected_user_id":"a","password":"p","confirm":true,"confirm_text":"DELETE"}`, code: 200, called: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := &deletingAuthStub{stubAuthService: &stubAuthService{}, err: tt.err}
			h := NewAuthHandler(s, nil, nil, nil, nil, nil, nil)
			r := httptest.NewRequest("POST", "/api/users/me/delete", strings.NewReader(tt.body))
			ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: "a"})
			r = r.WithContext(context.WithValue(ctx, AuthSessionContextKey, "actor"))
			w := httptest.NewRecorder()
			h.DeleteAccount(w, r)
			if w.Code != tt.code || (s.calls > 0) != tt.called {
				t.Fatalf("status %d calls %d body %s", w.Code, s.calls, w.Body)
			}
			if s.calls > 0 && (s.owner != "a" || s.sid != "actor") {
				t.Fatal("wrong session bound")
			}
			if len(w.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("deletion mutated shared cookies")
			}
			if tt.code == 200 && (!strings.Contains(w.Body.String(), `"personal_asset_cleanup":"queued"`) || !strings.Contains(w.Body.String(), `"shared_history":"retained"`)) {
				t.Fatal("misleading deletion result", w.Body.String())
			}
		})
	}
}
