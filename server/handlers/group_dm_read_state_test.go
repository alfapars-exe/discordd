package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type groupReadServiceStub struct {
	services.GroupDMService
	calls   int
	failure error
}

func (s *groupReadServiceStub) MarkRead(_ context.Context, group, user string, message *string) (*models.GroupDMReadState, error) {
	s.calls++
	if group != "group" || user != "reader" || message == nil || *message != "message" {
		return nil, pkg.ErrBadRequest
	}
	return &models.GroupDMReadState{GroupID: group, LastReadMessageID: message, Revision: 8}, nil
}

func TestGroupDMReadDecodesChunkedBody(t *testing.T) {
	svc := &groupReadServiceStub{}
	handler := &GroupDMHandler{service: svc}
	req := httptest.NewRequest(http.MethodPost, "/api/group-dms/group/read", strings.NewReader(`{"message_id":"message"}`))
	req.ContentLength = -1
	req.SetPathValue("groupId", "group")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "reader"}))
	response := httptest.NewRecorder()
	handler.MarkRead(response, req)
	if response.Code != 200 || svc.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, svc.calls, response.Body.String())
	}
}

func (s *groupReadServiceStub) MarkUnreadFrom(_ context.Context, group, user, message string) (*models.GroupDMReadState, error) {
	s.calls++
	if s.failure != nil {
		return nil, s.failure
	}
	if group != "group" || user != "reader" || message != "message" {
		return nil, pkg.ErrBadRequest
	}
	return &models.GroupDMReadState{GroupID: group, UnreadCount: 2, Revision: 5}, nil
}
func TestGroupDMUnreadHTTP(t *testing.T) {
	for _, test := range []struct {
		name, body string
		user       bool
		failure    error
		status     int
	}{
		{"success", `{"message_id":"message"}`, true, nil, 200},
		{"no session", `{"message_id":"message"}`, false, nil, 401},
		{"nonmember", `{"message_id":"message"}`, true, pkg.ErrNotFound, 404},
		{"forbidden", `{"message_id":"message"}`, true, pkg.ErrForbidden, 403},
		{"malformed", `{`, true, nil, 400},
		{"unknown field", `{"message_id":"message","user_id":"other"}`, true, nil, 400},
		{"trailing JSON", `{"message_id":"message"}{}`, true, nil, 400},
		{"blank", `{"message_id":""}`, true, nil, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc := &groupReadServiceStub{failure: test.failure}
			handler := &GroupDMHandler{service: svc}
			req := httptest.NewRequest(http.MethodPost, "/api/group-dms/group/unread", strings.NewReader(test.body))
			req.SetPathValue("groupId", "group")
			if test.user {
				req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "reader"}))
			}
			response := httptest.NewRecorder()
			handler.MarkUnread(response, req)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
			if test.status == 200 {
				var envelope struct {
					Success bool                    `json:"success"`
					Data    models.GroupDMReadState `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if !envelope.Success || envelope.Data.Revision != 5 || envelope.Data.UnreadCount != 2 {
					t.Fatalf("response=%+v", envelope)
				}
			}
			if (test.name == "no session" || test.name == "malformed" || test.name == "unknown field" || test.name == "trailing JSON") && svc.calls != 0 {
				t.Fatal("invalid request reached service")
			}
		})
	}
}
