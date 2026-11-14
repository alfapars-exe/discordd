package handlers

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestDMHandlerDeclaresCompletionReplayAndDeletionReceipt(t *testing.T) {
	dependency := reflect.TypeOf(NewDMHandler).In(0)
	required := reflect.TypeFor[interface {
		FinalizeDMCreate(context.Context, *models.DMMessage) error
		GetDMEvents(context.Context, string, string, int64) (*services.DMEventPage, error)
		DeleteMessageWithReceipt(context.Context, string, string) (*models.DMMessageDeleteReceipt, error)
	}]()
	if !dependency.Implements(required) {
		t.Fatal("DM handler dependency hides delivery request capabilities")
	}
}

type dmCompletionStub struct {
	services.DMRequestService
	ctx   context.Context
	msg   *models.DMMessage
	fail  error
	calls []string
}

func (s *dmCompletionStub) FinalizeDMCreate(ctx context.Context, msg *models.DMMessage) error {
	s.ctx, s.msg = ctx, msg
	s.calls = append(s.calls, "finalize")
	return s.fail
}
func (s *dmCompletionStub) BroadcastCreate(msg *models.DMMessage) {
	if msg != s.msg {
		panic("broadcast replaced committed message")
	}
	s.calls = append(s.calls, "broadcast")
}
func TestDMCompletionPreservesContextAndPublicationOrder(t *testing.T) {
	sentinel := errors.New("completion failed")
	for _, failure := range []error{nil, sentinel} {
		t.Run(map[bool]string{true: "failure", false: "success"}[failure != nil], func(t *testing.T) {
			stub := &dmCompletionStub{fail: failure}
			handler := NewDMHandler(stub, nil, 0, nil, nil)
			req := httptest.NewRequest("POST", "/api/dms/ch/messages", nil)
			msg := &models.DMMessage{ID: "committed"}
			err := handler.finishDMSend(req, msg)
			if !errors.Is(err, failure) || stub.ctx != req.Context() || stub.msg != msg {
				t.Fatalf("completion lost context/message/error: %v", err)
			}
			want := []string{"finalize"}
			if failure == nil {
				want = append(want, "broadcast")
			}
			if !reflect.DeepEqual(stub.calls, want) {
				t.Fatalf("calls=%v want=%v", stub.calls, want)
			}
		})
	}
}
