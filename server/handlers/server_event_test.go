package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type serverEventServiceStub struct {
	calls       int
	lastLimit   int
	lastBefore  string
	lastVersion int64
	lastRSVP    bool
	result      models.ServerEvent
}

func (s *serverEventServiceStub) Create(_ context.Context, _, actor string, req *models.CreateServerEventRequest) (*models.ServerEvent, error) {
	s.calls++
	s.result.CreatorID, s.result.Name = actor, req.Name
	return &s.result, nil
}
func (s *serverEventServiceStub) List(_ context.Context, _, _ string, limit int, before string) ([]models.ServerEvent, error) {
	s.calls++
	s.lastLimit, s.lastBefore = limit, before
	return []models.ServerEvent{s.result}, nil
}
func (s *serverEventServiceStub) Get(context.Context, string, string, string) (*models.ServerEvent, error) {
	s.calls++
	return &s.result, nil
}
func (s *serverEventServiceStub) Update(_ context.Context, _, _, _ string, req *models.UpdateServerEventRequest) (*models.ServerEvent, error) {
	s.calls++
	s.lastVersion, s.result.Name = req.ExpectedVersion, req.Name
	return &s.result, nil
}
func (s *serverEventServiceStub) Cancel(_ context.Context, _, _, _ string, version int64) (*models.ServerEvent, error) {
	s.calls++
	s.lastVersion = version
	return &s.result, nil
}
func (s *serverEventServiceStub) SetInterested(_ context.Context, _, _, _ string, interested bool) error {
	s.calls++
	s.lastRSVP = interested
	return nil
}

func serverEventRequest(method, path, body, expectedUser string) *http.Request {
	if expectedUser != "" {
		separator := "?"
		if strings.Contains(path, "?") {
			separator = "&"
		}
		path += separator + "expected_user_id=" + expectedUser
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	ctx := context.WithValue(req.Context(), UserContextKey, &models.User{ID: "user-1"})
	ctx = context.WithValue(ctx, ServerIDContextKey, "server-1")
	req = req.WithContext(ctx)
	req.SetPathValue("eventId", "event-1")
	return req
}

func TestServerEventHandlerRequiresAuthAndRejectsAccountMismatchOnEveryRoute(t *testing.T) {
	service := &serverEventServiceStub{}
	h := NewServerEventHandler(service)
	routes := []struct {
		name, method, path, body string
		handler                  http.HandlerFunc
	}{
		{"list", http.MethodGet, "/api/servers/server-1/events", "", h.List},
		{"detail", http.MethodGet, "/api/servers/server-1/events/event-1", "", h.Get},
		{"create", http.MethodPost, "/api/servers/server-1/events", `{"name":"event"}`, h.Create},
		{"update", http.MethodPatch, "/api/servers/server-1/events/event-1", `{"expected_version":1,"name":"event"}`, h.Update},
		{"cancel", http.MethodPost, "/api/servers/server-1/events/event-1/cancel", `{"expected_version":1}`, h.Cancel},
		{"rsvp", http.MethodPut, "/api/servers/server-1/events/event-1/rsvp", `{"interested":true}`, h.RSVP},
	}
	for _, route := range routes {
		t.Run(route.name+" invalid authenticated user", func(t *testing.T) {
			for _, user := range []*models.User{nil, {ID: ""}, {ID: "   "}} {
				req := serverEventRequest(route.method, route.path, route.body, "")
				req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
				response := httptest.NewRecorder()
				before := service.calls
				route.handler(response, req)
				if response.Code != http.StatusUnauthorized || service.calls != before {
					t.Fatalf("invalid user: status=%d calls=%d", response.Code, service.calls)
				}
			}
		})
		t.Run(route.name+" unauthenticated", func(t *testing.T) {
			req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
			response := httptest.NewRecorder()
			route.handler(response, req)
			if response.Code != http.StatusUnauthorized || service.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want 401 and no service call", response.Code, service.calls, response.Body.String())
			}
		})
		t.Run(route.name+" account mismatch", func(t *testing.T) {
			req := serverEventRequest(route.method, route.path, route.body, "other-user")
			response := httptest.NewRecorder()
			before := service.calls
			route.handler(response, req)
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "SERVER_EVENT_ACCOUNT_MISMATCH") || service.calls != before {
				t.Fatalf("status=%d calls=%d body=%s, want 409 mismatch and no service call", response.Code, service.calls, response.Body.String())
			}
		})
	}
}

func TestServerEventHandlerStrictBoundedBodiesAndListLimit(t *testing.T) {
	service := &serverEventServiceStub{}
	h := NewServerEventHandler(service)
	bad := []struct {
		name, method, path, body string
		handler                  http.HandlerFunc
	}{
		{"unknown field", http.MethodPost, "/api/servers/server-1/events", `{"name":"ok","unknown":true}`, h.Create},
		{"trailing JSON", http.MethodPost, "/api/servers/server-1/events", `{"name":"ok"} {}`, h.Create},
		{"missing RSVP bool", http.MethodPut, "/api/servers/server-1/events/event-1/rsvp", `{}`, h.RSVP},
		{"unknown RSVP field", http.MethodPut, "/api/servers/server-1/events/event-1/rsvp", `{"interested":false,"extra":1}`, h.RSVP},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, serverEventRequest(tc.method, tc.path, tc.body, "user-1"))
			if response.Code != http.StatusBadRequest || service.calls != 0 {
				t.Fatalf("status=%d calls=%d body=%s, want 400 and no service call", response.Code, service.calls, response.Body.String())
			}
		})
	}
	response := httptest.NewRecorder()
	h.Create(response, serverEventRequest(http.MethodPost, "/api/servers/server-1/events", `{"name":"`+strings.Repeat("x", serverEventBodyMaxBytes)+`"}`, "user-1"))
	if response.Code != http.StatusRequestEntityTooLarge || service.calls != 0 {
		t.Fatalf("oversize status=%d calls=%d, want 413 and no service call", response.Code, service.calls)
	}
	for _, limit := range []string{"nope", "0", "101", "10&limit=20"} {
		response = httptest.NewRecorder()
		req := serverEventRequest(http.MethodGet, "/api/servers/server-1/events", "", "user-1")
		req.URL.RawQuery += "&limit=" + limit
		h.List(response, req)
		if response.Code != http.StatusBadRequest {
			t.Errorf("limit %q: status=%d, want 400", limit, response.Code)
		}
	}
}

func TestServerEventHandlerHappyResponses(t *testing.T) {
	service := &serverEventServiceStub{result: models.ServerEvent{ID: "event-1", ServerID: "server-1", Status: models.ServerEventStatusScheduled, Version: 1}}
	h := NewServerEventHandler(service)
	tests := []struct {
		name, method, path, body string
		handler                  http.HandlerFunc
		status                   int
	}{
		{"list", http.MethodGet, "/api/servers/server-1/events?limit=7&before_id=cursor", "", h.List, http.StatusOK},
		{"detail", http.MethodGet, "/api/servers/server-1/events/event-1", "", h.Get, http.StatusOK},
		{"create", http.MethodPost, "/api/servers/server-1/events", `{"name":"Launch","starts_at":"2030-01-01T00:00:00Z"}`, h.Create, http.StatusCreated},
		{"update", http.MethodPatch, "/api/servers/server-1/events/event-1", `{"expected_version":3,"name":"Updated","starts_at":"2030-01-01T00:00:00Z"}`, h.Update, http.StatusOK},
		{"cancel", http.MethodPost, "/api/servers/server-1/events/event-1/cancel", `{"expected_version":4}`, h.Cancel, http.StatusOK},
		{"rsvp", http.MethodPut, "/api/servers/server-1/events/event-1/rsvp", `{"interested":true}`, h.RSVP, http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			tc.handler(response, serverEventRequest(tc.method, tc.path, tc.body, "user-1"))
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), tc.status)
			}
			if !strings.Contains(response.Body.String(), "event-1") && tc.name != "rsvp" {
				t.Errorf("response missing event payload: %s", response.Body.String())
			}
		})
	}
	if service.lastLimit != 7 || service.lastBefore != "cursor" || service.lastVersion != 4 || !service.lastRSVP {
		t.Fatalf("service inputs: limit=%d before=%q version=%d rsvp=%v", service.lastLimit, service.lastBefore, service.lastVersion, service.lastRSVP)
	}
}

func TestServerEventHandlerRejectsMissingServerContext(t *testing.T) {
	service := &serverEventServiceStub{}
	h := NewServerEventHandler(service)
	req := serverEventRequest(http.MethodGet, "/api/servers/server-1/events", "", "user-1")
	req = req.WithContext(context.WithValue(req.Context(), ServerIDContextKey, ""))
	response := httptest.NewRecorder()
	h.List(response, req)
	if response.Code != http.StatusBadRequest || service.calls != 0 {
		t.Fatalf("status=%d calls=%d, want 400 and no service call: %s", response.Code, service.calls, response.Body.String())
	}
}
