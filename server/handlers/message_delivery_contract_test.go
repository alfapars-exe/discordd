package handlers

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestMessageHandlerRequiresCompletionAndAttachmentState(t *testing.T) {
	dependency := reflect.TypeOf(NewMessageHandler).In(0)
	required := reflect.TypeFor[interface {
		ChannelEvents(context.Context, string, string, string, int64) (*services.ChannelEventPage, error)
		ChannelDeliveryHealth(context.Context) (*services.ChannelDeliveryHealth, error)
		KeepChannelSendAlive(context.Context, string) func()
		CompleteChannelSend(context.Context, *models.Message) error
		AttachmentOutcome(context.Context, string, int, *models.Attachment, string) error
	}]()
	if !dependency.Implements(required) {
		t.Fatal("handler dependency hides delivery completion and attachment state")
	}
}

type messageCompletionRecorder struct {
	*stubMessageService
	completed     *models.Message
	contexts      []context.Context
	outcomes      []int
	attachmentIDs []string
	failures      []string
	leaseID       string
	leaseStopped  bool
}

func (r *messageCompletionRecorder) KeepChannelSendAlive(_ context.Context, id string) func() {
	r.leaseID = id
	return func() { r.leaseStopped = true }
}
func (r *messageCompletionRecorder) CompleteChannelSend(ctx context.Context, message *models.Message) error {
	r.contexts = append(r.contexts, ctx)
	r.completed = message
	return errors.New("completion fixture error")
}
func (r *messageCompletionRecorder) AttachmentOutcome(ctx context.Context, id string, index int, attachment *models.Attachment, failure string) error {
	r.contexts = append(r.contexts, ctx)
	r.outcomes = append(r.outcomes, index)
	r.attachmentIDs = append(r.attachmentIDs, id)
	r.failures = append(r.failures, failure)
	return errors.New("attachment fixture error")
}
func TestMessageCreateDeclaredDeliveryHooksPreservePartialResponseAndReleaseBudgets(t *testing.T) {
	service := &messageCompletionRecorder{stubMessageService: &stubMessageService{}}
	uploads := &stubUploadService{failFor: map[string]error{"b.png": errors.New("fixture upload failure")}}
	handler := NewMessageHandler(service, uploads, 1<<20, nil, nil)
	body, contentType := multipartBody(t, "with files", map[string]string{"a.png": "ok", "b.png": "failed"}, nil)
	response := httptest.NewRecorder()
	handler.Create(response, newCreateRequest(t, body, contentType))
	if response.Code != http.StatusMultiStatus {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if service.completed == nil || len(service.completed.Attachments) != 1 || service.completed.ServerID == "" {
		t.Fatal("completion did not receive finalized message")
	}
	if service.leaseID != service.completed.ID || !service.leaseStopped {
		t.Fatal("upload lease was not released")
	}
	if len(service.outcomes) != 2 || service.outcomes[0] != 0 || service.outcomes[1] != 1 || service.attachmentIDs[0] != service.completed.ID || service.attachmentIDs[1] != service.completed.ID {
		t.Fatal("attachment outcome identity/index lost")
	}
	if service.failures[0] != "" || service.failures[1] == "" {
		t.Fatal("attachment success/failure distinction lost")
	}
	for _, ctx := range service.contexts {
		if _, ok := ctx.Deadline(); !ok || !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("delivery hook budget not bounded/released")
		}
	}
	if service.broadcastCount() != 0 {
		t.Fatal("completion error triggered a second delivery path")
	}
}

type messageDeliveryReaderRecorder struct {
	*stubMessageService
	eventsCalls, healthCalls int
	scope                    []string
	cursor                   int64
	ctx                      context.Context
	err                      error
}

func (r *messageDeliveryReaderRecorder) ChannelEvents(ctx context.Context, server, channel, user string, cursor int64) (*services.ChannelEventPage, error) {
	r.eventsCalls++
	r.scope = []string{server, channel, user}
	r.cursor = cursor
	r.ctx = ctx
	return &services.ChannelEventPage{Cursor: 42, Reset: true}, r.err
}
func (r *messageDeliveryReaderRecorder) ChannelDeliveryHealth(ctx context.Context) (*services.ChannelDeliveryHealth, error) {
	r.healthCalls++
	r.ctx = ctx
	return &services.ChannelDeliveryHealth{Pending: 3}, r.err
}
func TestMessageDeliveryReadEndpointsUseDeclaredContract(t *testing.T) {
	for _, tc := range []struct {
		name, cursor          string
		authenticated, health bool
		err                   error
		status, calls         int
	}{
		{name: "events success", cursor: "17", authenticated: true, status: 200, calls: 1},
		{name: "events forbidden", cursor: "17", authenticated: true, err: fmt.Errorf("scope: %w", pkg.ErrForbidden), status: 403, calls: 1},
		{name: "events disabled", cursor: "0", authenticated: true, err: pkg.ErrNotFound, status: 404, calls: 1},
		{name: "missing actor", cursor: "17", status: 401},
		{name: "negative cursor", cursor: "-1", authenticated: true, status: 400},
		{name: "malformed cursor", cursor: "invalid", authenticated: true, status: 400},
		{name: "health success", health: true, status: 200, calls: 1},
		{name: "health disabled", health: true, err: pkg.ErrNotFound, status: 404, calls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := &messageDeliveryReaderRecorder{stubMessageService: &stubMessageService{}, err: tc.err}
			handler := NewMessageHandler(service, nil, 0, nil, nil)
			request := httptest.NewRequest(http.MethodGet, "/delivery?after_sequence="+tc.cursor, nil)
			request.SetPathValue("id", "delivery-channel")
			ctx := context.WithValue(request.Context(), ServerIDContextKey, "delivery-server")
			if tc.authenticated {
				ctx = context.WithValue(ctx, UserContextKey, &models.User{ID: "reader"})
			}
			request = request.WithContext(ctx)
			response := httptest.NewRecorder()
			if tc.health {
				handler.DeliveryHealth(response, request)
			} else {
				handler.Events(response, request)
			}
			if response.Code != tc.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if service.eventsCalls+service.healthCalls != tc.calls {
				t.Fatal("unexpected backend call count")
			}
			if tc.calls > 0 && service.ctx != request.Context() {
				t.Fatal("request context lost")
			}
			if !tc.health && tc.calls > 0 {
				if !reflect.DeepEqual(service.scope, []string{"delivery-server", "delivery-channel", "reader"}) {
					t.Fatal("event authorization scope lost")
				}
				if tc.cursor == "17" && service.cursor != 17 {
					t.Fatal("event cursor lost")
				}
			}
			if tc.status == 200 {
				field := `"cursor":42`
				if tc.health {
					field = `"pending":3`
				}
				if !strings.Contains(response.Body.String(), field) {
					t.Fatalf("response fields lost: %s", response.Body.String())
				}
			}
		})
	}
}
