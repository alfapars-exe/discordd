package services

// DM read state + dm_request inbox row: the write set SendMessage runs
// inside the DM transaction, and MarkRead's membership gate / dm_read echo.
// Shares newDMFixture (dm_message_test.go).

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// acceptedFriendsFixture — alice and bob are friends on an accepted channel,
// so SendMessage takes the plain happy path.
func acceptedFriendsFixture(f *dmTestFixture) {
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: id, DMPrivacy: "accepted"}, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) { return true, nil }
}

func TestSendMessage_BumpsRecipientUnreadInsideTx(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.repo.CreateMessageFn = func(_ context.Context, m *models.DMMessage) error { m.ID = "committed-source"; return nil }

	var bumped []string
	f.dmRead.IncrementUnreadFn = func(_ context.Context, userID, channelID string) error {
		bumped = append(bumped, userID+"@"+channelID)
		return nil
	}
	notifCreated := false
	f.notif.CreateFn = func(_ context.Context, _ *models.Notification) error { notifCreated = true; return nil }
	var incoming *models.Notification
	f.notif.CreateDMMessageIfAbsentFn = func(_ context.Context, n *models.Notification) (bool, error) { incoming = n; return true, nil }

	if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hi"}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(bumped) != 1 || bumped[0] != "bob@ch-1" {
		t.Errorf("IncrementUnread calls = %v, want exactly [bob@ch-1] (recipient only)", bumped)
	}
	if notifCreated {
		t.Error("accepted DM must not create a dm_request notification")
	}
	if incoming == nil || incoming.UserID != "bob" || incoming.ActorID == nil || *incoming.ActorID != "alice" || incoming.DMChannelID == nil || *incoming.DMChannelID != "ch-1" || incoming.MessageID == nil || *incoming.MessageID == "" || len(incoming.Payload) != 0 {
		t.Fatalf("missing/body-bearing incoming metadata: %+v", incoming)
	}
}

func TestSendMessage_IncomingNotificationFailureCannotBroadcastSuccess(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.notif.CreateDMMessageIfAbsentFn = func(context.Context, *models.Notification) (bool, error) { return false, errors.New("write failed") }
	events := 0
	f.hub.BroadcastToUserFn = func(string, ws.Event) { events++ }
	if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "private"}); err == nil {
		t.Fatal("notification write failure swallowed")
	}
	if events != 0 {
		t.Fatalf("broadcast after failed transaction: %d", events)
	}
}

func TestDMMarkRead_NotificationFailureCannotBroadcastSuccess(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.notif.MarkDMMessagesReadFn = func(context.Context, string, string, *string) ([]string, error) { return nil, errors.New("ack failed") }
	events := 0
	f.hub.BroadcastToUserFn = func(string, ws.Event) { events++ }
	if err := f.svc.MarkRead(context.Background(), "bob", "ch-1", nil); err == nil {
		t.Fatal("notification read failure swallowed")
	}
	if events != 0 {
		t.Fatalf("broadcast after failed read transaction: %d", events)
	}
}

// TestSendMessage_UnreadBumpFailureFailsTheSend — the bump is part of the
// atomic write set: its error surfaces as SendMessage's error.
func TestSendMessage_UnreadBumpFailureFailsTheSend(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.dmRead.IncrementUnreadFn = func(_ context.Context, _, _ string) error { return errors.New("disk full") }

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hi"})
	if err == nil {
		t.Fatal("expected the unread bump failure to surface from SendMessage")
	}
}

// TestSendMessage_PendingTransitionWritesDMRequestNotification — only the
// call that flips the channel to pending earns the recipient a dm_request
// row, pushed post-commit with the sender as actor.
func TestSendMessage_PendingTransitionWritesDMRequestNotification(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		u := &models.User{ID: id, Username: id, DMPrivacy: "accepted"}
		if id == "bob" {
			u.DMPrivacy = "message_request"
		}
		return u, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) { return false, nil }
	f.repo.CountMessagesBySenderFn = func(_ context.Context, _, _ string) (int, error) { return 0, nil }

	var row *models.Notification
	f.notif.CreateFn = func(_ context.Context, n *models.Notification) error {
		n.ID = "notif-1"
		row = n
		return nil
	}
	var pushedTo string
	var pushed ws.Event
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) {
		if e.Op == ws.OpNotificationCreate {
			pushedTo, pushed = userID, e
		}
	}

	if _, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hello?"}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if row == nil {
		t.Fatal("no dm_request notification was written on the pending transition")
	}
	if row.UserID != "bob" || row.Kind != models.NotificationKindDMRequest || *row.ActorID != "alice" || *row.DMChannelID != "ch-1" {
		t.Errorf("row = %+v", row)
	}
	if string(row.Payload) != `{}` {
		t.Errorf("payload = %s, want {}", row.Payload)
	}
	if pushedTo != "bob" {
		t.Errorf("notification_create pushed to %q, want bob", pushedTo)
	}
	if n, ok := pushed.Data.(*models.Notification); !ok || n.Actor == nil || n.Actor.ID != "alice" {
		t.Errorf("pushed data = %+v, want the row with alice as actor", pushed.Data)
	}
}

func TestDMMarkRead_RequiresMembershipAndEchoesDMRead(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		if id == "missing" {
			return nil, pkg.ErrNotFound
		}
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}
	var marked []string
	f.dmRead.MarkReadFn = func(_ context.Context, userID, channelID string, messageID *string) error {
		mid := "<nil>"
		if messageID != nil {
			mid = *messageID
		}
		marked = append(marked, userID+"@"+channelID+"#"+mid)
		return nil
	}
	var events []ws.Event
	var to []string
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) { to = append(to, userID); events = append(events, e) }

	err := f.svc.MarkRead(context.Background(), "carol", "ch-1", nil)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("outsider MarkRead err = %v, want ErrForbidden", err)
	}
	err = f.svc.MarkRead(context.Background(), "alice", "missing", nil)
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("unknown channel MarkRead err = %v, want ErrNotFound", err)
	}
	if len(marked) != 0 || len(events) != 0 {
		t.Fatalf("rejected calls still wrote/broadcast: marked=%v events=%d", marked, len(events))
	}

	mid := "m-9"
	if err := f.svc.MarkRead(context.Background(), "alice", "ch-1", &mid); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if len(marked) != 1 || marked[0] != "alice@ch-1#m-9" {
		t.Errorf("MarkRead repo calls = %v", marked)
	}
	if len(events) != 1 || events[0].Op != ws.OpDMRead || to[0] != "alice" {
		t.Fatalf("events = %+v to %v, want one dm_read to alice only", events, to)
	}
	data := events[0].Data.(map[string]any)
	if data["dm_channel_id"] != "ch-1" || data["user_id"] != "alice" || data["last_read_message_id"] != &mid {
		t.Errorf("dm_read data = %v", data)
	}
}

func TestDMMarkRead_EchoesActualStoredCursorAndRemainingUnread(t *testing.T) {
	for i, request := range []*string{nil, strPtr("old-request")} {
		t.Run([]string{"bodyless", "older-source"}[i], func(t *testing.T) {
			f := newDMFixture()
			acceptedFriendsFixture(f)
			marked := false
			f.dmRead.MarkReadFn = func(context.Context, string, string, *string) error { marked = true; return nil }
			f.svc.(*dmService).txRunner = passthroughDMTxRunner{repos: repository.DMTxRepos{DM: f.repo, DMRead: f.dmRead, Notification: f.notif,
				ReadState: func(context.Context, string, string) (*string, int, error) {
					if !marked {
						t.Fatal("read state sampled before write")
					}
					return strPtr("stored-latest"), 2, nil
				}}}
			var event ws.Event
			f.hub.BroadcastToUserFn = func(_ string, e ws.Event) { event = e }
			if err := f.svc.MarkRead(context.Background(), "bob", "ch-1", request); err != nil {
				t.Fatal(err)
			}
			data := event.Data.(map[string]any)
			cursor, ok := data["last_read_message_id"].(*string)
			if event.Op != ws.OpDMRead || !ok || cursor == nil || *cursor != "stored-latest" || data["unread_count"] != 2 {
				t.Fatalf("echo did not use stored state: %+v", event)
			}
		})
	}
}

func TestDMMarkUnreadFrom_RecomputesAndSynchronizes(t *testing.T) {
	f := newDMFixture()
	acceptedFriendsFixture(f)
	f.dmRead.MarkUnreadFromFn = func(_ context.Context, userID, channelID, messageID string) (int, error) {
		if userID != "alice" || channelID != "ch-1" || messageID != "m-2" {
			t.Fatalf("unexpected args %s %s %s", userID, channelID, messageID)
		}
		return 3, nil
	}
	var target string
	var event ws.Event
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) { target, event = userID, e }
	count, err := f.svc.MarkUnreadFrom(context.Background(), "alice", "ch-1", "m-2")
	if err != nil || count != 3 {
		t.Fatalf("MarkUnreadFrom=(%d,%v), want (3,nil)", count, err)
	}
	if target != "alice" || event.Op != ws.OpDMRead {
		t.Fatalf("event target=%q event=%+v", target, event)
	}
	data := event.Data.(map[string]any)
	if data["unread_count"] != 3 || data["last_read_message_id"] != "m-2" {
		t.Fatalf("data=%v", data)
	}

	if _, err := f.svc.MarkUnreadFrom(context.Background(), "carol", "ch-1", "m-2"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("outsider err=%v want forbidden", err)
	}
}

func TestDMDeleteMessage_CleansNotificationsBestEffort(t *testing.T) {
	f := newDMFixture()
	f.repo.GetMessageByIDFn = func(_ context.Context, id string) (*models.DMMessage, error) {
		return &models.DMMessage{ID: id, DMChannelID: "ch-1", UserID: "alice"}, nil
	}
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}
	var cleaned string
	f.notif.DeleteByMessageIDFn = func(_ context.Context, id string) error { cleaned = id; return errors.New("transient") }

	if err := f.svc.DeleteMessage(context.Background(), "alice", "m-1"); err != nil {
		t.Fatalf("DeleteMessage must not fail on a notification cleanup error: %v", err)
	}
	if cleaned != "m-1" {
		t.Errorf("DeleteByMessageID called with %q, want m-1", cleaned)
	}
}
