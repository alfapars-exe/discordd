package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

type scheduledEmailCapture struct {
	user, category, dedupe, subject, body string
	options                               EmailEnqueueOptions
	err                                   error
	calls                                 int
}

func (f *scheduledEmailCapture) EnqueueWithOptions(_ context.Context, user, category, dedupe, subject, body string, options EmailEnqueueOptions) (bool, error) {
	f.calls++
	f.user, f.category, f.dedupe, f.subject, f.body, f.options = user, category, dedupe, subject, body, options
	return true, f.err
}

func TestSendMessage_EnqueuesDelayedGenericUnreadEmailOnlyForAcceptedDM(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.repo.CreateMessageFn = func(_ context.Context, msg *models.DMMessage) error { msg.ID = "message-123"; return nil }
	enqueuer := &scheduledEmailCapture{}
	f.svc.(DMCommunicationEmailConfigurer).SetCommunicationEmailEnqueuer(enqueuer)

	ciphertext := "encrypted payload"
	device := "device-1"
	if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &ciphertext, SenderDeviceID: &device}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if enqueuer.calls != 1 || enqueuer.user != "bob" || enqueuer.category != models.EmailCategoryCommunication || enqueuer.dedupe != "unread-dm:message-123" {
		t.Fatalf("email enqueue = %+v, want one communication notice for the recipient/message", enqueuer)
	}
	if strings.Contains(enqueuer.subject+enqueuer.body, "alice") || strings.Contains(enqueuer.subject+enqueuer.body, "secret plaintext") || strings.Contains(enqueuer.subject+enqueuer.body, "encrypted payload") || strings.Contains(enqueuer.body, "message-123") {
		t.Fatalf("email contains message or identity data: %+v", enqueuer)
	}
	if enqueuer.options.DMMessageID != "message-123" || enqueuer.options.NotBefore.IsZero() || enqueuer.options.ExpiresAt.Sub(enqueuer.options.NotBefore) != 23*time.Hour+50*time.Minute {
		t.Fatalf("email event context/timing = %+v", enqueuer.options)
	}
}

func TestSendMessage_SkipsUnreadEmailForPendingRequestAndSelfDM(t *testing.T) {
	t.Run("pending first message", func(t *testing.T) {
		f := newDMFixture()
		f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
			return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
		}
		f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
			p := "message_request"
			if id == "alice" {
				p = "accepted"
			}
			return &models.User{ID: id, Username: id, DMPrivacy: p}, nil
		}
		f.friends.AreFriendsFn = func(context.Context, string, string) (bool, error) { return false, nil }
		f.repo.CountMessagesBySenderFn = func(context.Context, string, string) (int, error) { return 0, nil }
		f.repo.CreateMessageFn = func(_ context.Context, msg *models.DMMessage) error { msg.ID = "pending-message"; return nil }
		e := &scheduledEmailCapture{}
		f.svc.(DMCommunicationEmailConfigurer).SetCommunicationEmailEnqueuer(e)
		if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "request"}); err != nil {
			t.Fatal(err)
		}
		if e.calls != 0 {
			t.Fatalf("pending request enqueued %d emails", e.calls)
		}
	})
	t.Run("self DM", func(t *testing.T) {
		f := newDMFixture()
		f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
			return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "alice", Status: models.DMStatusAccepted}, nil
		}
		f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
			return &models.User{ID: id, Username: id}, nil
		}
		f.repo.CreateMessageFn = func(_ context.Context, msg *models.DMMessage) error { msg.ID = "self-message"; return nil }
		e := &scheduledEmailCapture{}
		f.svc.(DMCommunicationEmailConfigurer).SetCommunicationEmailEnqueuer(e)
		if _, err := f.svc.SendMessage(context.Background(), "alice", "self", &models.CreateDMMessageRequest{Content: "note"}); err != nil {
			t.Fatal(err)
		}
		if e.calls != 0 {
			t.Fatalf("self DM enqueued %d emails", e.calls)
		}
	})
}

func TestSendMessage_UnreadEmailEnqueueFailureDoesNotFailCommittedMessage(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.repo.CreateMessageFn = func(_ context.Context, msg *models.DMMessage) error { msg.ID = "message-123"; return nil }
	e := &scheduledEmailCapture{err: errors.New("sensitive provider detail")}
	f.svc.(DMCommunicationEmailConfigurer).SetCommunicationEmailEnqueuer(e)
	if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hello"}); err != nil {
		t.Fatalf("best-effort email failure changed successful DM send: %v", err)
	}
	if e.calls != 1 {
		t.Fatalf("email enqueue calls=%d, want 1", e.calls)
	}
}
