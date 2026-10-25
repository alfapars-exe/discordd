package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type gameGrantHandlerFake struct {
	fakeBotService
	calls              int
	actor, application string
	expected           int64
	enabled, revoke    bool
	err                error
}

func (f *gameGrantHandlerFake) RegisterGameIdentity(_ context.Context, actor, app string) (*models.ApplicationGameIdentity, error) {
	f.calls++
	f.actor = actor
	f.application = app
	return &models.ApplicationGameIdentity{ApplicationID: app, IsGameApplication: true}, f.err
}
func (f *gameGrantHandlerFake) ListGameGrants(_ context.Context, actor string) ([]models.ApplicationGameGrant, error) {
	f.calls++
	f.actor = actor
	return []models.ApplicationGameGrant{}, f.err
}
func (f *gameGrantHandlerFake) ChangeGameGrant(_ context.Context, actor, app string, expected int64, enabled, revoke bool) (*models.ApplicationGameGrant, error) {
	f.calls++
	f.actor = actor
	f.application = app
	f.expected = expected
	f.enabled = enabled
	f.revoke = revoke
	return &models.ApplicationGameGrant{ApplicationID: app, Revision: expected + 1, MessagingEnabled: enabled}, f.err
}

func TestGameGrantHandlersHumanBoundaryAndStrictBody(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		handler    string
		bot        bool
		status     int
	}{
		{"register", "", "register", false, 200}, {"register-empty-object", "{}", "register", false, 200},
		{"self-trust-rejected", `{"first_party":true}`, "register", false, 400},
		{"register-bot", "", "register", true, 403},
		{"list", "", "list", false, 200}, {"list-bot", "", "list", true, 403},
		{"create", `{"expected_revision":0,"messaging_enabled":true}`, "put", false, 200},
		{"disable", `{"expected_revision":2,"messaging_enabled":false}`, "put", false, 200},
		{"missing-revision", `{"messaging_enabled":true}`, "put", false, 400},
		{"missing-toggle", `{"expected_revision":2}`, "put", false, 400},
		{"foreign-user-field", `{"expected_revision":2,"messaging_enabled":true,"user_id":"victim"}`, "put", false, 400},
		{"put-bot", `{"expected_revision":0,"messaging_enabled":true}`, "put", true, 403},
		{"revoke", `{"expected_revision":2}`, "delete", false, 200},
		{"revoke-missing-revision", `{}`, "delete", false, 400},
		{"revoke-toggle-rejected", `{"expected_revision":2,"messaging_enabled":true}`, "delete", false, 400},
		{"trailing-json", `{"expected_revision":2} {}`, "delete", false, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &gameGrantHandlerFake{}
			h := NewBotHandler(f)
			req := withUser(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body)), &models.User{ID: "current-user", IsBot: tc.bot})
			req.SetPathValue("botID", "game")
			w := httptest.NewRecorder()
			switch tc.handler {
			case "register":
				h.RegisterGameIdentity(w, req)
			case "list":
				h.ListGameGrants(w, req)
			case "put":
				h.PutGameGrant(w, req)
			case "delete":
				h.RevokeGameGrant(w, req)
			}
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if tc.status == 200 {
				if f.calls != 1 || f.actor != "current-user" {
					t.Fatalf("caller not authoritative: %+v", f)
				}
			} else if f.calls != 0 {
				t.Fatal("invalid request reached service")
			}
		})
	}
}
func TestGameGrantHandlersConflictUsesMachineCode(t *testing.T) {
	f := &gameGrantHandlerFake{err: pkg.ErrConflict}
	h := NewBotHandler(f)
	req := withUser(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"expected_revision":3,"messaging_enabled":false}`)), &models.User{ID: "alice"})
	req.SetPathValue("botID", "game")
	w := httptest.NewRecorder()
	h.PutGameGrant(w, req)
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"CONFLICT"`) {
		t.Fatalf("response=%d %s", w.Code, w.Body.String())
	}
}
