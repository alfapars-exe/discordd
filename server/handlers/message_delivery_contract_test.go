package handlers

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestMessageHandlerRequiresCompletionAndAttachmentState(t *testing.T) {
	dependency := reflect.TypeOf(NewMessageHandler).In(0)
	required := reflect.TypeFor[interface {
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
