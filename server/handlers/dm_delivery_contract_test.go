package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
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

type dmReplayStub struct {
	services.DMRequestService
	calls         int
	ctx           context.Context
	user, channel string
	after         int64
	fail          error
}

func (s *dmReplayStub) GetDMEvents(ctx context.Context, user, channel string, after int64) (*services.DMEventPage, error) {
	s.calls++
	s.ctx, s.user, s.channel, s.after = ctx, user, channel, after
	return &services.DMEventPage{Cursor: "43", HasMore: true}, s.fail
}
func TestDMReplayHTTPValidatesAndPreservesScope(t *testing.T) {
	for _, tc := range []struct {
		name, cursor  string
		authenticated bool
		fail          error
		status, calls int
	}{
		{"anonymous", "42", false, nil, 401, 0},
		{"missing cursor", "", true, nil, 400, 0},
		{"negative cursor", "-1", true, nil, 400, 0},
		{"malformed cursor", "abc", true, nil, 400, 0},
		{"forbidden", "42", true, pkg.ErrForbidden, 403, 1},
		{"success", "42", true, nil, 200, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &dmReplayStub{fail: tc.fail}
			handler := NewDMHandler(stub, nil, 0, nil, nil)
			req := httptest.NewRequest("GET", "/api/dms/channel/events?after="+tc.cursor, nil)
			req.SetPathValue("channelId", "channel")
			if tc.authenticated {
				req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "reader"}))
			}
			response := httptest.NewRecorder()
			handler.GetEvents(response, req)
			if response.Code != tc.status || stub.calls != tc.calls {
				t.Fatalf("status=%d calls=%d body=%s", response.Code, stub.calls, response.Body.String())
			}
			if stub.calls > 0 && (stub.ctx != req.Context() || stub.user != "reader" || stub.channel != "channel" || stub.after != 42) {
				t.Fatal("replay scope/cursor/context lost")
			}
			if tc.status == 200 {
				var body struct {
					Data services.DMEventPage `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body.Data.Cursor != "43" || !body.Data.HasMore {
					t.Fatalf("page=%+v", body.Data)
				}
			}
		})
	}
}
