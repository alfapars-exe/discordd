package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

func TestGetOrCreateSelfChannel_CreatesOnceAndBroadcastsToSelf(t *testing.T) {
	f := newDMFixture()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "alice", PasswordHash: "never"}, nil
	}
	var created *models.DMChannel
	f.repo.GetChannelByUsersFn = func(_ context.Context, u1, u2 string) (*models.DMChannel, error) {
		if u1 != "alice" || u2 != "alice" {
			t.Errorf("GetChannelByUsers(%s, %s), want (alice, alice)", u1, u2)
		}
		return created, nil
	}
	f.repo.CreateChannelFn = func(_ context.Context, ch *models.DMChannel) error {
		ch.ID = "self-1"
		created = ch
		return nil
	}
	var broadcasts []string
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) {
		if e.Op == ws.OpDMChannelCreate {
			broadcasts = append(broadcasts, userID)
		}
	}

	result, err := f.svc.GetOrCreateSelfChannel(context.Background(), "alice")
	if err != nil {
		t.Fatalf("GetOrCreateSelfChannel: %v", err)
	}
	if result.ID != "self-1" || result.Status != models.DMStatusAccepted {
		t.Errorf("result = %+v, want the new accepted channel", result)
	}
	if result.OtherUser == nil || result.OtherUser.ID != "alice" {
		t.Errorf("other_user = %+v, want the caller", result.OtherUser)
	}
	if created == nil || created.User1ID != "alice" || created.User2ID != "alice" {
		t.Errorf("created channel = %+v, want user1 == user2 == alice", created)
	}
	if len(broadcasts) != 1 || broadcasts[0] != "alice" {
		t.Errorf("dm_channel_create broadcasts = %v, want exactly one to alice", broadcasts)
	}

	// Second call: existing row, no create, no broadcast.
	again, err := f.svc.GetOrCreateSelfChannel(context.Background(), "alice")
	if err != nil {
		t.Fatalf("second GetOrCreateSelfChannel: %v", err)
	}
	if again.ID != "self-1" || len(broadcasts) != 1 {
		t.Errorf("second call = %+v, broadcasts %v; want the same channel, no new broadcast", again, broadcasts)
	}
}

// TestGetOrCreateSelfChannel_UniqueRaceReturnsWinner — a concurrent first
// call loses on UNIQUE(user1_id, user2_id); it re-reads and returns the
// winner's channel instead of failing, and does not broadcast again.
func TestGetOrCreateSelfChannel_UniqueRaceReturnsWinner(t *testing.T) {
	f := newDMFixture()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "alice"}, nil
	}
	lookups := 0
	f.repo.GetChannelByUsersFn = func(_ context.Context, _, _ string) (*models.DMChannel, error) {
		lookups++
		if lookups == 1 {
			return nil, nil // not there yet when we first looked
		}
		return &models.DMChannel{ID: "winner", User1ID: "alice", User2ID: "alice", Status: models.DMStatusAccepted}, nil
	}
	f.repo.CreateChannelFn = func(_ context.Context, _ *models.DMChannel) error {
		return errors.New("UNIQUE constraint failed: dm_channels.user1_id, dm_channels.user2_id")
	}
	broadcasts := 0
	f.hub.BroadcastToUserFn = func(_ string, _ ws.Event) { broadcasts++ }

	got, err := f.svc.GetOrCreateSelfChannel(context.Background(), "alice")
	if err != nil {
		t.Fatalf("GetOrCreateSelfChannel: %v", err)
	}
	if got.ID != "winner" || got.OtherUser == nil || got.OtherUser.ID != "alice" {
		t.Errorf("result = %+v, want the winner's channel with other_user = caller", got)
	}
	if broadcasts != 0 {
		t.Errorf("race loser broadcast %d time(s), want 0", broadcasts)
	}

	// A create failure with no row to fall back on is still an error.
	f.repo.GetChannelByUsersFn = func(_ context.Context, _, _ string) (*models.DMChannel, error) { return nil, nil }
	if _, err := f.svc.GetOrCreateSelfChannel(context.Background(), "alice"); err == nil {
		t.Error("create failure without a winner row returned no error")
	}
}

func TestGetOrCreateSelfChannel_UnknownUser(t *testing.T) {
	f := newDMFixture()
	f.users.GetByIDFn = func(_ context.Context, _ string) (*models.User, error) { return nil, pkg.ErrNotFound }
	if _, err := f.svc.GetOrCreateSelfChannel(context.Background(), "ghost"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

// TestGetOrCreateChannel_StillRejectsSelf — the generic POST /api/dms guard
// stays: only /api/dms/self may create a self channel.
func TestGetOrCreateChannel_StillRejectsSelf(t *testing.T) {
	f := newDMFixture()
	if _, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "alice"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("GetOrCreateChannel(self) err = %v, want ErrBadRequest", err)
	}
}

// TestSendMessage_SelfChannel_SkipsPeerGates — on a self channel the block
// check, the privacy/request flow and the recipient unread bump are all
// skipped; the message is still persisted and the sender's own unhide runs.
func TestSendMessage_SelfChannel_SkipsPeerGates(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "alice", Status: models.DMStatusAccepted}, nil
	}
	// A privacy setting that would normally trip the request flow.
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "alice", DMPrivacy: "message_request"}, nil
	}
	f.block.IsBlockedFn = func(_ context.Context, _, _ string) (bool, error) {
		t.Fatal("block check must not run for a self channel")
		return false, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) {
		t.Fatal("friendship check must not run for a self channel")
		return false, nil
	}
	f.repo.TransitionToPendingFn = func(_ context.Context, _, _ string) error {
		t.Fatal("self channel must never transition to pending")
		return nil
	}
	f.dmRead.IncrementUnreadFn = func(_ context.Context, userID, _ string) error {
		t.Fatalf("IncrementUnread(%s) must not run for a self channel", userID)
		return nil
	}
	f.notif.CreateFn = func(_ context.Context, n *models.Notification) error {
		t.Fatalf("no notification expected on a self channel, got %s", n.Kind)
		return nil
	}
	var unhidden []string
	f.unhide.UnhideForNewMessageFn = func(_ context.Context, userID, _ string) error {
		unhidden = append(unhidden, userID)
		return nil
	}
	var persisted *models.DMMessage
	f.repo.CreateMessageFn = func(_ context.Context, m *models.DMMessage) error {
		m.ID = "note-1"
		persisted = m
		return nil
	}

	msg, err := f.svc.SendMessage(context.Background(), "alice", "self-1", &models.CreateDMMessageRequest{Content: "remember the milk"})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if persisted == nil || msg.ID != "note-1" || msg.UserID != "alice" {
		t.Errorf("message = %+v, persisted = %+v", msg, persisted)
	}
	if len(unhidden) != 1 || unhidden[0] != "alice" {
		t.Errorf("unhide calls = %v, want exactly one for the sender", unhidden)
	}
}
