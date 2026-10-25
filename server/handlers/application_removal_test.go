package handlers

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type applicationRemovalAuthStub struct {
	*stubAuthService
	calls             int
	err               error
	owner, sid, botID string
}

func (s *applicationRemovalAuthStub) RemoveApplication(_ context.Context, owner, sid, botID, _, _ string) error {
	s.calls++
	s.owner, s.sid, s.botID = owner, sid, botID
	return s.err
}

func TestRemoveApplicationExplicitConsentAndAffinity(t *testing.T) {
	for _, tt := range []struct {
		name, body, pathID string
		code               int
		called             bool
		err                error
	}{
		{name: "no typed consent", pathID: "app", body: `{"expected_user_id":"a","expected_application_id":"app","password":"p","confirm":true}`, code: 400},
		{name: "wrong account", pathID: "app", body: `{"expected_user_id":"b","expected_application_id":"app","password":"p","confirm":true,"confirm_text":"REMOVE"}`, code: 409},
		{name: "wrong application", pathID: "app", body: `{"expected_user_id":"a","expected_application_id":"other","password":"p","confirm":true,"confirm_text":"REMOVE"}`, code: 409},
		{name: "no separate confirmation", pathID: "app", body: `{"expected_user_id":"a","expected_application_id":"app","password":"p","confirm_text":"REMOVE"}`, code: 400},
		{name: "unknown field", pathID: "app", body: `{"expected_user_id":"a","extra":true}`, code: 400},
		{name: "extra json", pathID: "app", body: `{} {}`, code: 400},
		{name: "bounded", pathID: "app", body: `{"password":"` + strings.Repeat("x", 9000) + `"}`, code: 400},
		{name: "owned server", pathID: "app", body: `{"expected_user_id":"a","expected_application_id":"app","password":"p","confirm":true,"confirm_text":"REMOVE"}`, code: 409, called: true, err: repository.ErrDeletionOwnsServers},
		{name: "confirmed", pathID: "app", body: `{"expected_user_id":"a","expected_application_id":"app","password":"p","confirm":true,"confirm_text":"REMOVE"}`, code: 200, called: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := &applicationRemovalAuthStub{stubAuthService: &stubAuthService{}, err: tt.err}
			h := NewAuthHandler(s, nil, nil, nil, nil, nil, nil)
			r := httptest.NewRequest("POST", "/api/bots/"+tt.pathID+"/remove", strings.NewReader(tt.body))
			r.SetPathValue("botID", tt.pathID)
			ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: "a"})
			r = r.WithContext(context.WithValue(ctx, AuthSessionContextKey, "actor-session"))
			w := httptest.NewRecorder()
			h.RemoveApplication(w, r)
			if w.Code != tt.code || (s.calls > 0) != tt.called {
				t.Fatalf("status %d calls %d body %s", w.Code, s.calls, w.Body)
			}
			if s.calls > 0 && (s.owner != "a" || s.sid != "actor-session" || s.botID != "app") {
				t.Fatalf("wrong operation binding: owner=%q sid=%q bot=%q", s.owner, s.sid, s.botID)
			}
			if len(w.Header().Values("Set-Cookie")) != 0 {
				t.Fatal("application removal mutated shared cookies")
			}
			if tt.code == 200 && (!strings.Contains(w.Body.String(), `"personal_asset_cleanup":"queued"`) || !strings.Contains(w.Body.String(), `"shared_history":"retained"`)) {
				t.Fatal("misleading removal result", w.Body.String())
			}
		})
	}
}
