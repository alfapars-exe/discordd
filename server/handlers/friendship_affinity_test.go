package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFriendshipAccountMismatchBeforeDelegation(t *testing.T) {
	h := NewFriendshipHandler(nil, nil)
	for _, handler := range []func(http.ResponseWriter, *http.Request){h.ListFriends, h.ListRequests, h.SendRequest, h.AcceptRequest, h.DeclineRequest, h.RemoveFriend} {
		req := httptest.NewRequest(http.MethodPost, "/api/friends?expected_user_id=old-account", nil)
		req.SetPathValue("id", "request")
		req.SetPathValue("userId", "peer")
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "new-account"}))
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusConflict {
			t.Fatalf("expected identity conflict before nil service: %d %s", rec.Code, rec.Body.String())
		}
	}
}
