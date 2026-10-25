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

type groupMuteService struct {
	services.GroupDMService
	calls int
	user  string
}

func (s *groupMuteService) SetMuted(_ context.Context, group, user string, muted bool) (*models.GroupDMReadState, error) {
	s.calls++
	s.user = user
	return &models.GroupDMReadState{GroupID: group, IsMuted: muted, SettingsRevision: 1}, nil
}
func TestGroupDMSettingsHTTPUsesAuthenticatedMemberAndStrictBoolean(t *testing.T) {
	for _, body := range []string{`{}`, `{"is_muted":null}`, `{"is_muted":"true"}`, `{"is_muted":true,"user_id":"someone"}`} {
		stub := &groupMuteService{}
		handler := &GroupDMHandler{service: stub}
		request := httptest.NewRequest(http.MethodPatch, "/api/group-dms/group/settings", strings.NewReader(body))
		request.SetPathValue("groupId", "group")
		request = request.WithContext(context.WithValue(request.Context(), UserContextKey, &models.User{ID: "reader"}))
		response := httptest.NewRecorder()
		handler.SetMuted(response, request)
		if response.Code != http.StatusBadRequest || stub.calls != 0 {
			t.Fatalf("body=%s status=%d calls=%d", body, response.Code, stub.calls)
		}
	}
	stub := &groupMuteService{}
	handler := &GroupDMHandler{service: stub}
	request := httptest.NewRequest(http.MethodPatch, "/api/group-dms/group/settings?expected_user_id=reader", strings.NewReader(`{"is_muted":true}`))
	request.SetPathValue("groupId", "group")
	request = request.WithContext(context.WithValue(request.Context(), UserContextKey, &models.User{ID: "reader"}))
	response := httptest.NewRecorder()
	handler.SetMuted(response, request)
	if response.Code != http.StatusOK || stub.calls != 1 || stub.user != "reader" {
		t.Fatalf("status=%d calls=%d user=%s", response.Code, stub.calls, stub.user)
	}
	request = httptest.NewRequest(http.MethodPatch, "/api/group-dms/group/settings?expected_user_id=old-owner", strings.NewReader(`{"is_muted":false}`))
	request = request.WithContext(context.WithValue(request.Context(), UserContextKey, &models.User{ID: "reader"}))
	response = httptest.NewRecorder()
	handler.SetMuted(response, request)
	if response.Code != http.StatusConflict || stub.calls != 1 {
		t.Fatalf("account mismatch wrote settings: status=%d calls=%d", response.Code, stub.calls)
	}
}
