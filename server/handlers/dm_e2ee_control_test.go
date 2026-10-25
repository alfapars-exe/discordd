package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

type dmEncryptionControlStub struct {
	services.DMService
	calls int
}

func (s *dmEncryptionControlStub) ToggleE2EE(context.Context, string, string, bool) (*models.DMChannel, error) {
	s.calls++
	return &models.DMChannel{ID: "dm"}, nil
}
func TestDMEncryptionHandlerRejectsBotsBeforeMutation(t *testing.T) {
	for _, enabled := range []string{"true", "false"} {
		svc := &dmEncryptionControlStub{}
		h := NewDMHandler(svc, nil, 0, nil, nil)
		req := withUser(httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"enabled":`+enabled+`}`)), &models.User{ID: "bot", IsBot: true})
		req.SetPathValue("channelId", "dm")
		w := httptest.NewRecorder()
		h.ToggleE2EE(w, req)
		if w.Code != 403 || svc.calls != 0 {
			t.Fatalf("bot toggle=%d calls=%d", w.Code, svc.calls)
		}
	}
	svc := &dmEncryptionControlStub{}
	h := NewDMHandler(svc, nil, 0, nil, nil)
	req := withUser(httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"enabled":true}`)), &models.User{ID: "human"})
	req.SetPathValue("channelId", "dm")
	w := httptest.NewRecorder()
	h.ToggleE2EE(w, req)
	if w.Code != 200 || svc.calls != 1 {
		t.Fatalf("human toggle=%d calls=%d", w.Code, svc.calls)
	}
}
