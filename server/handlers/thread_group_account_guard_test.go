package handlers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

type accountGuardThreadService struct {
	services.ThreadService
	calls int
}

func (s *accountGuardThreadService) Create(context.Context, string, string, string, *models.CreateThreadRequest) (*models.Channel, error) {
	s.calls++
	return &models.Channel{}, nil
}
func (s *accountGuardThreadService) List(context.Context, string, string, string, bool) ([]models.Channel, error) {
	s.calls++
	return []models.Channel{}, nil
}
func (s *accountGuardThreadService) Get(context.Context, string, string, string) (*models.Channel, error) {
	s.calls++
	return &models.Channel{ID: "thread", Type: models.ChannelTypeThread}, nil
}
func (s *accountGuardThreadService) SetArchived(context.Context, string, string, string, bool) (*models.Channel, error) {
	s.calls++
	return &models.Channel{}, nil
}

type accountGuardGroupService struct {
	services.GroupDMService
	addCalls, removeCalls, leaveCalls int
}

func (s *accountGuardGroupService) AddMember(context.Context, string, string, string) (*models.GroupDM, error) {
	s.addCalls++
	return &models.GroupDM{}, nil
}
func (s *accountGuardGroupService) RemoveMember(context.Context, string, string, string) (*models.GroupDM, error) {
	s.removeCalls++
	return &models.GroupDM{}, nil
}
func (s *accountGuardGroupService) Leave(context.Context, string, string) error {
	s.leaveCalls++
	return nil
}

type accountGuardBody struct {
	reader io.Reader
	reads  int
}

func (b *accountGuardBody) Read(p []byte) (int, error) { b.reads++; return b.reader.Read(p) }
func (*accountGuardBody) Close() error                 { return nil }

func accountGuardRequest(method, target string, body io.ReadCloser, user *models.User) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	if body != nil {
		req.Body = body
	}
	ctx := context.WithValue(req.Context(), UserContextKey, user)
	ctx = context.WithValue(ctx, ServerIDContextKey, "server")
	return req.WithContext(ctx)
}

func requireAccountMismatch(t *testing.T, response *httptest.ResponseRecorder, code string, calls int) {
	t.Helper()
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"`+code+`"`) || calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s, want 409 %s and no calls", response.Code, calls, response.Body.String(), code)
	}
}

func TestThreadAccountMismatchPrecedesBodyAndService(t *testing.T) {
	for _, test := range []struct {
		name, method, path, body string
		handle                   func(*ThreadHandler, http.ResponseWriter, *http.Request)
	}{
		{"create", http.MethodPost, "/api/threads", `{`, (*ThreadHandler).Create},
		{"list", http.MethodGet, "/api/threads", `ignored`, (*ThreadHandler).List},
		{"get", http.MethodGet, "/api/threads/thread", `ignored`, (*ThreadHandler).Get},
		{"set archived", http.MethodPatch, "/api/threads/thread/archive", `{`, (*ThreadHandler).SetArchived},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc := &accountGuardThreadService{}
			handler := NewThreadHandler(svc)
			body := &accountGuardBody{reader: strings.NewReader(test.body)}
			req := accountGuardRequest(test.method, test.path+"?expected_user_id=old", body, &models.User{ID: "current"})
			req.SetPathValue("channelId", "channel")
			req.SetPathValue("threadId", "thread")
			response := httptest.NewRecorder()
			test.handle(handler, response, req)
			requireAccountMismatch(t, response, "THREAD_ACCOUNT_MISMATCH", svc.calls)
			if body.reads != 0 {
				t.Fatalf("read body %d times before rejecting account mismatch", body.reads)
			}
		})
	}
}

func TestThreadGetExpectedUserQueryIsOptionalAndPassedToService(t *testing.T) {
	svc := &accountGuardThreadService{}
	request := accountGuardRequest(http.MethodGet, "/api/servers/server/threads/thread", nil, &models.User{ID: "current"})
	request.SetPathValue("threadId", "thread")
	response := httptest.NewRecorder()
	NewThreadHandler(svc).Get(response, request)
	if response.Code != http.StatusOK || svc.calls != 1 || !strings.Contains(response.Body.String(), `"id":"thread"`) {
		t.Fatalf("status=%d calls=%d body=%s, want thread response", response.Code, svc.calls, response.Body.String())
	}
}

func TestThreadContextRejectsTypedNilUser(t *testing.T) {
	var user *models.User
	svc := &accountGuardThreadService{}
	request := accountGuardRequest(http.MethodGet, "/api/threads", nil, user)
	response := httptest.NewRecorder()
	NewThreadHandler(svc).List(response, request)
	if response.Code != http.StatusUnauthorized || svc.calls != 0 {
		t.Fatalf("status=%d calls=%d, want unauthorized with no service call", response.Code, svc.calls)
	}
}

func TestThreadExpectedUserQueryIsOptional(t *testing.T) {
	svc := &accountGuardThreadService{}
	request := accountGuardRequest(http.MethodGet, "/api/threads", nil, &models.User{ID: "current"})
	request.SetPathValue("channelId", "channel")
	response := httptest.NewRecorder()
	NewThreadHandler(svc).List(response, request)
	if response.Code != http.StatusOK || svc.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s, want legacy request to reach service", response.Code, svc.calls, response.Body.String())
	}
}

func TestGroupAccountMismatchPrecedesBodyServiceAndLimiter(t *testing.T) {
	for _, test := range []struct {
		name, method, path, body string
		handle                   func(*GroupDMHandler, http.ResponseWriter, *http.Request)
	}{
		{"add member", http.MethodPost, "/api/group-dms/group/members", `{`, (*GroupDMHandler).AddMember},
		{"remove member", http.MethodDelete, "/api/group-dms/group/members/user", `ignored`, (*GroupDMHandler).RemoveMember},
		{"leave", http.MethodPost, "/api/group-dms/group/leave", `ignored`, (*GroupDMHandler).Leave},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc := &accountGuardGroupService{}
			limiter := ratelimit.NewMessageRateLimiter(1, time.Hour, 0)
			handler := NewGroupDMHandler(svc, nil, 0, nil, limiter, nil)
			body := &accountGuardBody{reader: strings.NewReader(test.body)}
			req := accountGuardRequest(test.method, test.path+"?expected_user_id=old", body, &models.User{ID: "current"})
			req.SetPathValue("groupId", "group")
			req.SetPathValue("userId", "user")
			response := httptest.NewRecorder()
			test.handle(handler, response, req)
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"GROUP_ACCOUNT_MISMATCH"`) || svc.addCalls+svc.removeCalls+svc.leaveCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want 409 GROUP_ACCOUNT_MISMATCH and no calls", response.Code, svc.addCalls+svc.removeCalls+svc.leaveCalls, response.Body.String())
			}
			if body.reads != 0 {
				t.Fatalf("read body %d times before rejecting account mismatch", body.reads)
			}
		})
	}
}

func TestGroupAddMemberAccountMismatchDoesNotConsumeLimiterAndQueryIsOptional(t *testing.T) {
	svc := &accountGuardGroupService{}
	limiter := ratelimit.NewMessageRateLimiter(1, time.Hour, 0)
	handler := NewGroupDMHandler(svc, nil, 0, nil, limiter, nil)
	wrong := accountGuardRequest(http.MethodPost, "/api/group-dms/group/members?expected_user_id=old", io.NopCloser(strings.NewReader(`{"user_id":"new-member"}`)), &models.User{ID: "current"})
	wrong.SetPathValue("groupId", "group")
	response := httptest.NewRecorder()
	handler.AddMember(response, wrong)
	if response.Code != http.StatusConflict || svc.addCalls != 0 {
		t.Fatalf("mismatch status=%d calls=%d", response.Code, svc.addCalls)
	}
	accepted := accountGuardRequest(http.MethodPost, "/api/group-dms/group/members", io.NopCloser(strings.NewReader(`{"user_id":"new-member"}`)), &models.User{ID: "current"})
	accepted.SetPathValue("groupId", "group")
	response = httptest.NewRecorder()
	handler.AddMember(response, accepted)
	if response.Code != http.StatusOK || svc.addCalls != 1 {
		t.Fatalf("legacy request status=%d calls=%d body=%s", response.Code, svc.addCalls, response.Body.String())
	}
}

func TestGroupAccountGuardRejectsTypedNilUser(t *testing.T) {
	var user *models.User
	for _, handle := range []func(*GroupDMHandler, http.ResponseWriter, *http.Request){(*GroupDMHandler).AddMember, (*GroupDMHandler).RemoveMember, (*GroupDMHandler).Leave} {
		svc := &accountGuardGroupService{}
		request := accountGuardRequest(http.MethodPost, "/api/group-dms/group?expected_user_id=current", nil, user)
		request.SetPathValue("groupId", "group")
		response := httptest.NewRecorder()
		handle(NewGroupDMHandler(svc, nil, 0, nil, nil, nil), response, request)
		if response.Code != http.StatusUnauthorized || svc.addCalls+svc.removeCalls+svc.leaveCalls != 0 {
			t.Fatalf("status=%d calls=%d, want unauthorized with no service call", response.Code, svc.addCalls+svc.removeCalls+svc.leaveCalls)
		}
	}
}
