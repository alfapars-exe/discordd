package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReminderAccountMismatchBeforeService(t *testing.T) {
	h := NewReminderHandler(nil)
	for _, handler := range []func(http.ResponseWriter, *http.Request){h.List, h.Create, h.Update, h.Cancel} {
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/reminders?expected_user_id=old", nil)
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "new"}))
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusConflict {
			t.Fatalf("status=%d", rec.Code)
		}
	}
}
