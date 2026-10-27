package services

// Stale request notifications: accepting / declining / cancelling a friend
// request and accepting / declining a DM request retire the recipient's
// inbox row (best-effort) and push notification_read with the fresh count.
// DM side shares newDMFixture (dm_message_test.go).

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// stubFriendRepo is the minimal repository.FriendshipRepository the
// accept/decline paths touch; every other method is an unused no-op.
type stubFriendRepo struct {
	byID map[string]*models.Friendship
}

func (s *stubFriendRepo) Create(_ context.Context, _ *models.Friendship) error { return nil }
func (s *stubFriendRepo) GetByID(_ context.Context, id string) (*models.Friendship, error) {
	if f, ok := s.byID[id]; ok {
		cp := *f
		return &cp, nil
	}
	return nil, errors.New("not found")
}
func (s *stubFriendRepo) GetByPair(_ context.Context, _, _ string) (*models.Friendship, error) {
	return nil, errors.New("not found")
}
func (s *stubFriendRepo) ListFriends(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendRepo) ListIncoming(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendRepo) ListOutgoing(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendRepo) UpdateStatus(_ context.Context, _ string, _ models.FriendshipStatus) error {
	return nil
}
func (s *stubFriendRepo) Delete(_ context.Context, _ string) error          { return nil }
func (s *stubFriendRepo) DeleteByPair(_ context.Context, _, _ string) error { return nil }
func (s *stubFriendRepo) ListBlocked(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (s *stubFriendRepo) IsBlocked(_ context.Context, _, _ string) (bool, error) { return false, nil }

// readEvents collects notification_read pushes per user.
type readEvents struct {
	to   []string
	data []map[string]any
}

func (r *readEvents) hook() func(string, ws.Event) {
	return func(userID string, e ws.Event) {
		if e.Op == ws.OpNotificationRead {
			r.to = append(r.to, userID)
			r.data = append(r.data, e.Data.(map[string]any))
		}
	}
}

func newFriendshipFixture(t *testing.T) (FriendshipService, *testutil.MockNotificationRepo, *readEvents) {
	t.Helper()
	pending := &models.Friendship{
		ID: "fr-1", UserID: "alice", FriendID: "bob",
		Status: models.FriendshipStatusPending, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: id}, nil
	}}
	notif := &testutil.MockNotificationRepo{}
	ev := &readEvents{}
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: ev.hook()}
	svc := NewFriendshipService(&stubFriendRepo{byID: map[string]*models.Friendship{"fr-1": pending}}, users, notif, hub)
	return svc, notif, ev
}

func TestFriendshipAccept_SettlesRecipientNotification(t *testing.T) {
	svc, notif, ev := newFriendshipFixture(t)
	var marked []string
	notif.MarkFriendRequestReadFn = func(_ context.Context, userID, actorID string) ([]string, error) {
		marked = append(marked, userID+"<-"+actorID)
		return []string{"n-1"}, nil
	}
	notif.CountUnreadFn = func(_ context.Context, _ string) (int, error) { return 3, nil }

	if _, err := svc.AcceptRequest(context.Background(), "bob", "fr-1"); err != nil {
		t.Fatalf("AcceptRequest: %v", err)
	}
	if len(marked) != 1 || marked[0] != "bob<-alice" {
		t.Errorf("MarkFriendRequestRead calls = %v, want [bob<-alice] (recipient, sender as actor)", marked)
	}
	if len(ev.to) != 1 || ev.to[0] != "bob" {
		t.Fatalf("notification_read sent to %v, want [bob]", ev.to)
	}
	d := ev.data[0]
	if ids := d["ids"].([]string); len(ids) != 1 || ids[0] != "n-1" || d["all"] != false || d["unread_count"] != 3 {
		t.Errorf("notification_read data = %v, want ids=[n-1] all=false unread_count=3", d)
	}
}

// TestFriendshipDecline_SettlesRecipientEvenWhenSenderCancels — the
// recipient (FriendID) owns the inbox row regardless of who ended the
// request, so a sender-side cancel still retires bob's entry.
func TestFriendshipDecline_SettlesRecipientEvenWhenSenderCancels(t *testing.T) {
	svc, notif, ev := newFriendshipFixture(t)
	var marked []string
	notif.MarkFriendRequestReadFn = func(_ context.Context, userID, actorID string) ([]string, error) {
		marked = append(marked, userID+"<-"+actorID)
		return []string{"n-1"}, nil
	}

	if err := svc.DeclineRequest(context.Background(), "alice", "fr-1"); err != nil {
		t.Fatalf("DeclineRequest (sender cancel): %v", err)
	}
	if len(marked) != 1 || marked[0] != "bob<-alice" {
		t.Errorf("MarkFriendRequestRead calls = %v, want [bob<-alice]", marked)
	}
	if len(ev.to) != 1 || ev.to[0] != "bob" {
		t.Errorf("notification_read sent to %v, want [bob]", ev.to)
	}
}

// TestFriendshipAccept_SettleIsBestEffort — a repo failure or an empty
// match never fails the accept and never pushes a notification_read.
func TestFriendshipAccept_SettleIsBestEffort(t *testing.T) {
	svc, notif, ev := newFriendshipFixture(t)
	notif.MarkFriendRequestReadFn = func(_ context.Context, _, _ string) ([]string, error) {
		return nil, errors.New("db down")
	}
	if _, err := svc.AcceptRequest(context.Background(), "bob", "fr-1"); err != nil {
		t.Fatalf("AcceptRequest must not fail on a notification settle error: %v", err)
	}
	if len(ev.to) != 0 {
		t.Errorf("notification_read pushed after a settle error: %v", ev.to)
	}

	svc, notif, ev = newFriendshipFixture(t)
	notif.MarkFriendRequestReadFn = func(_ context.Context, _, _ string) ([]string, error) { return []string{}, nil }
	notif.CountUnreadFn = func(_ context.Context, _ string) (int, error) {
		t.Fatal("CountUnread must not run when nothing was marked")
		return 0, nil
	}
	if _, err := svc.AcceptRequest(context.Background(), "bob", "fr-1"); err != nil {
		t.Fatalf("AcceptRequest: %v", err)
	}
	if len(ev.to) != 0 {
		t.Errorf("notification_read pushed although no row was marked: %v", ev.to)
	}
}

func pendingDMFixture(f *dmTestFixture) {
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusPending, InitiatedBy: strPtr("alice")}, nil
	}
}

func TestDMAcceptRequest_SettlesRecipientNotification(t *testing.T) {
	f := newDMFixture()
	pendingDMFixture(f)
	var marked []string
	f.notif.MarkDMRequestReadFn = func(_ context.Context, userID, channelID string) ([]string, error) {
		marked = append(marked, userID+"@"+channelID)
		return []string{"n-dm"}, nil
	}
	f.notif.CountUnreadFn = func(_ context.Context, _ string) (int, error) { return 0, nil }
	ev := &readEvents{}
	f.hub.BroadcastToUserFn = ev.hook()

	if err := f.svc.AcceptRequest(context.Background(), "bob", "ch-1"); err != nil {
		t.Fatalf("AcceptRequest: %v", err)
	}
	if len(marked) != 1 || marked[0] != "bob@ch-1" {
		t.Errorf("MarkDMRequestRead calls = %v, want [bob@ch-1]", marked)
	}
	if len(ev.to) != 1 || ev.to[0] != "bob" || ev.data[0]["unread_count"] != 0 {
		t.Errorf("notification_read = to %v data %v, want bob with unread_count 0", ev.to, ev.data)
	}
}

// Decline publishes the channel event and notification ids only after the
// atomic repository operation reports a committed delete.
func TestDMDeclineRequestPublishesCommittedNotificationIDs(t *testing.T) {
	f := newDMFixture()
	pendingDMFixture(f)
	committed := false
	f.repo.DeclinePendingFn = func(_ context.Context, channelID, recipientID string) (bool, []string, []string, error) {
		if channelID != "ch-1" || recipientID != "bob" {
			t.Fatalf("DeclinePending(%q,%q)", channelID, recipientID)
		}
		committed = true
		return true, nil, []string{"n-dm"}, nil
	}
	ev := &readEvents{}
	f.hub.BroadcastToUserFn = func(userID string, event ws.Event) {
		if !committed {
			t.Fatalf("event %s published before commit", event.Op)
		}
		ev.hook()(userID, event)
	}

	if err := f.svc.DeclineRequest(context.Background(), "bob", "ch-1"); err != nil {
		t.Fatalf("DeclineRequest: %v", err)
	}
	if len(ev.to) != 1 || ev.to[0] != "bob" {
		t.Errorf("notification_read sent to %v, want [bob]", ev.to)
	}
	if len(ev.data) != 1 || ev.data[0]["ids"] == nil {
		t.Fatalf("notification_read data = %v, want committed ids", ev.data)
	}
	ids, ok := ev.data[0]["ids"].([]string)
	if !ok || len(ids) != 1 || ids[0] != "n-dm" {
		t.Errorf("notification ids = %#v, want [n-dm]", ev.data[0]["ids"])
	}
}

func TestDMDeclineRequestFailureHasNoSideEffects(t *testing.T) {
	f := newDMFixture()
	pendingDMFixture(f)
	dir := t.TempDir()
	f.svc.(*dmService).SetUploadDir(dir)
	path := filepath.Join(dir, "still-live.png")
	if err := os.WriteFile(path, []byte("attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("transaction rolled back")
	f.repo.DeclinePendingFn = func(context.Context, string, string) (bool, []string, []string, error) {
		return false, []string{"/api/uploads/still-live.png"}, []string{"notification-1"}, failure
	}
	broadcasts := 0
	f.hub.BroadcastToUserFn = func(string, ws.Event) { broadcasts++ }
	if err := f.svc.DeclineRequest(context.Background(), "bob", "ch-1"); !errors.Is(err, failure) {
		t.Fatalf("DeclineRequest error=%v, want transaction failure", err)
	}
	if broadcasts != 0 {
		t.Errorf("broadcasts=%d after failed transaction, want 0", broadcasts)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("attachment removed after rollback: %v", err)
	}
}

func TestDMDeclineRequestLosingRaceHasNoSideEffects(t *testing.T) {
	f := newDMFixture()
	pendingDMFixture(f)
	dir := t.TempDir()
	f.svc.(*dmService).SetUploadDir(dir)
	path := filepath.Join(dir, "must-stay.png")
	if err := os.WriteFile(path, []byte("attachment"), 0600); err != nil {
		t.Fatal(err)
	}
	f.notif.MarkDMRequestReadFn = func(context.Context, string, string) ([]string, error) {
		t.Fatal("losing decline must not mutate notifications")
		return nil, nil
	}
	f.repo.DeclinePendingFn = func(context.Context, string, string) (bool, []string, []string, error) {
		return false, []string{"/api/uploads/must-stay.png"}, []string{"notification-1"}, nil
	}
	broadcasts := 0
	f.hub.BroadcastToUserFn = func(string, ws.Event) { broadcasts++ }
	err := f.svc.DeclineRequest(context.Background(), "bob", "ch-1")
	if !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("DeclineRequest error=%v, want ErrConflict", err)
	}
	if broadcasts != 0 {
		t.Errorf("broadcasts=%d for losing decline, want 0", broadcasts)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("attachment removed for losing decline: %v", err)
	}
}

func TestDMAcceptPendingChannels_SettlesNonInitiatorOnly(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByUsersFn = func(_ context.Context, _, _ string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: "ch-1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusPending, InitiatedBy: strPtr("alice")}, nil
	}
	f.notif.MarkDMRequestReadFn = func(_ context.Context, userID, _ string) ([]string, error) {
		if userID == "bob" {
			return []string{"n-dm"}, nil // only the recipient held a row
		}
		return []string{}, nil
	}
	ev := &readEvents{}
	f.hub.BroadcastToUserFn = ev.hook()

	if err := f.svc.AcceptPendingChannels(context.Background(), "bob", "alice"); err != nil {
		t.Fatalf("AcceptPendingChannels: %v", err)
	}
	if len(ev.to) != 1 || ev.to[0] != "bob" {
		t.Errorf("notification_read sent to %v, want [bob] only (initiator matched nothing)", ev.to)
	}
}
