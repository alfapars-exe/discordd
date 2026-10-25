package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type ownershipAuthStub struct {
	*stubAuthService
	calls int
	args  []string
	err   error
}

func (s *ownershipAuthStub) TransferServerOwnership(_ context.Context, actor, sid, serverID, target, password, code string) (*models.Server, error) {
	s.calls++
	s.args = []string{actor, sid, serverID, target, password, code}
	if s.err != nil {
		return nil, s.err
	}
	return &models.Server{ID: serverID, OwnerID: target}, nil
}

func TestOwnershipHandlerConsentAffinityAndErrors(t *testing.T) {
	valid := map[string]any{"expected_user_id": "a", "expected_server_id": "s", "target_user_id": "b", "password": "p", "code": "factor", "confirm": true, "confirm_text": "TRANSFER"}
	for _, tt := range []struct {
		name, key string
		value     any
		status    int
		err       error
		called    bool
	}{
		{name: "confirmed", status: 200, called: true},
		{name: "account switch", key: "expected_user_id", value: "other", status: 409},
		{name: "server switch", key: "expected_server_id", value: "other", status: 409},
		{name: "self transfer", key: "target_user_id", value: "a", status: 400},
		{name: "missing target", key: "target_user_id", value: "", status: 400},
		{name: "missing password", key: "password", value: "", status: 400},
		{name: "missing checkbox", key: "confirm", value: false, status: 400},
		{name: "typed consent", key: "confirm_text", value: "transfer", status: 400},
		{name: "unknown property", key: "extra", value: true, status: 400},
		{name: "bounded", key: "password", value: strings.Repeat("x", 9000), status: 400},
		{name: "ownership lost", status: 403, called: true, err: pkg.ErrForbidden},
		{name: "session lost", status: 401, called: true, err: pkg.ErrUnauthorized},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body := map[string]any{}
			for k, v := range valid {
				body[k] = v
			}
			if tt.key != "" {
				body[tt.key] = tt.value
			}
			encoded, _ := json.Marshal(body)
			s := &ownershipAuthStub{stubAuthService: &stubAuthService{}, err: tt.err}
			h := NewAuthHandler(s, nil, nil, nil, nil, nil, nil)
			r := httptest.NewRequest("POST", "/api/servers/s/transfer-ownership", strings.NewReader(string(encoded)))
			r.SetPathValue("serverId", "s")
			ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: "a"})
			r = r.WithContext(context.WithValue(ctx, AuthSessionContextKey, "sid"))
			w := httptest.NewRecorder()
			h.TransferServerOwnership(w, r)
			if w.Code != tt.status || (s.calls != 0) != tt.called {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, s.calls, w.Body)
			}
			if tt.called && strings.Join(s.args, ":") != "a:sid:s:b:p:factor" {
				t.Fatal("wrong bound credentials", s.args)
			}
			if len(w.Header().Values("Set-Cookie")) != 0 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unsafe response headers")
			}
		})
	}
}

func TestOwnershipHandlerRejectsUnboundOrMalformedRequests(t *testing.T) {
	for _, body := range []string{`{} {}`, `null`, `[]`, `{"confirm":true`, `{}`} {
		s := &ownershipAuthStub{stubAuthService: &stubAuthService{}}
		h := NewAuthHandler(s, nil, nil, nil, nil, nil, nil)
		r := httptest.NewRequest("POST", "/api/servers/s/transfer-ownership", strings.NewReader(body))
		r.SetPathValue("serverId", "s")
		w := httptest.NewRecorder()
		h.TransferServerOwnership(w, r)
		if w.Code != 401 || s.calls != 0 {
			t.Fatal("unbound session accepted", w.Code, s.calls)
		}
		ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: "a"})
		r = httptest.NewRequest("POST", "/api/servers/s/transfer-ownership", strings.NewReader(body)).WithContext(context.WithValue(ctx, AuthSessionContextKey, "sid"))
		r.SetPathValue("serverId", "s")
		w = httptest.NewRecorder()
		h.TransferServerOwnership(w, r)
		if w.Code < 400 || s.calls != 0 {
			t.Fatal("malformed body accepted", w.Code, s.calls)
		}
	}
}
