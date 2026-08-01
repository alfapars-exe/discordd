package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func strPtr(s string) *string { return &s }

// dmTestFixture wires a dmService against test-doubles with sensible
// defaults; individual tests override just the fields relevant to
// their scenario. This mirrors the pattern used across service tests.
type dmTestFixture struct {
	repo    *testutil.MockDMRepo
	users   *testutil.MockUserRepo
	block   *testutil.MockBlockChecker
	friends *testutil.MockFriendshipChecker
	unhide  *testutil.MockDMSettingsUnhider
	hub     *testutil.MockBroadcaster
	svc     DMService
}

func newDMFixture() *dmTestFixture {
	f := &dmTestFixture{
		repo:    &testutil.MockDMRepo{},
		users:   &testutil.MockUserRepo{},
		block:   &testutil.MockBlockChecker{},
		friends: &testutil.MockFriendshipChecker{},
		unhide:  &testutil.MockDMSettingsUnhider{},
		hub:     &testutil.MockBroadcaster{},
	}
	f.svc = NewDMService(f.repo, f.users, f.hub, f.block, f.friends, f.unhide)
	return f
}

// pendingChannelFixture — a pending DM channel initiated by "alice" for "bob".
// Tests override channel.InitiatedBy to explore the guard behavior.
func pendingChannelFixture(t *testing.T, f *dmTestFixture, initiatedBy *string) {
	t.Helper()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID:          id,
			User1ID:     "alice",
			User2ID:     "bob",
			Status:      models.DMStatusPending,
			InitiatedBy: initiatedBy,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, IsPlatformAdmin: false, DMPrivacy: "accepted"}, nil
	}
}

func TestSendMessage_pendingChannel_initiatorRejectedAsRequestPending(t *testing.T) {
	// Alice initiated the request; she can't send a second message until
	// Bob accepts. Guard returns dm_request_pending.
	f := newDMFixture()
	pendingChannelFixture(t, f, strPtr("alice"))

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hi again"})
	if err == nil {
		t.Fatal("expected pending guard rejection, got nil error")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("err chain missing ErrForbidden: %v", err)
	}
	if !strings.Contains(err.Error(), "dm_request_pending") {
		t.Errorf("err message = %q, want dm_request_pending", err.Error())
	}
}

func TestSendMessage_pendingChannel_recipientRejectedAsNotAccepted(t *testing.T) {
	// Bob is the recipient of Alice's request; he can't reply until he
	// explicitly accepts. Different error code so the client can surface
	// an "Accept request?" UI instead of a generic block.
	f := newDMFixture()
	pendingChannelFixture(t, f, strPtr("alice"))

	_, err := f.svc.SendMessage(context.Background(), "bob", "ch-1", &models.CreateDMMessageRequest{Content: "let me in"})
	if err == nil {
		t.Fatal("expected pending guard rejection, got nil error")
	}
	if !strings.Contains(err.Error(), "dm_request_not_accepted") {
		t.Errorf("err message = %q, want dm_request_not_accepted", err.Error())
	}
}

func TestSendMessage_pendingChannel_nilInitiatedByFailsClosed(t *testing.T) {
	// PRE-FIX REGRESSION GUARD:
	// dm_message.go used to gate both branches on "InitiatedBy != nil".
	// A pending row with InitiatedBy=NULL (data corruption, a failed
	// SetInitiatedBy at the accept-flow transition, or a migration gap)
	// bypassed both guards and turned the channel into a free-send row.
	// Fix is fail-closed: nil InitiatedBy on a pending channel returns
	// dm_request_not_accepted regardless of who's asking.
	f := newDMFixture()
	pendingChannelFixture(t, f, nil)

	// Only channel members can even reach the pending guard; verify both
	// user1 and user2 fail closed regardless of "who initiated" state.
	for _, sender := range []string{"alice", "bob"} {
		t.Run("sender="+sender, func(t *testing.T) {
			_, err := f.svc.SendMessage(context.Background(), sender, "ch-1",
				&models.CreateDMMessageRequest{Content: "hi"})
			if err == nil {
				t.Fatal("nil InitiatedBy accepted — regression, guard is bypassed")
			}
			if !errors.Is(err, pkg.ErrForbidden) {
				t.Errorf("err chain missing ErrForbidden: %v", err)
			}
			if !strings.Contains(err.Error(), "dm_request_not_accepted") {
				t.Errorf("err message = %q, want dm_request_not_accepted", err.Error())
			}
		})
	}
}

func TestSendMessage_platformAdminBypassesPendingGuard(t *testing.T) {
	// Platform admins are exempt from privacy guards (support / moderation
	// surface) — but the membership check is separate and still applies.
	// Setup a channel where the admin IS a member so we exercise the
	// intended pending-guard bypass.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID:          id,
			User1ID:     "admin",
			User2ID:     "bob",
			Status:      models.DMStatusPending,
			InitiatedBy: strPtr("admin"), // ← admin would normally hit "already sent"
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, IsPlatformAdmin: id == "admin", DMPrivacy: "accepted"}, nil
	}

	created := false
	f.repo.CreateMessageFn = func(_ context.Context, _ *models.DMMessage) error {
		created = true
		return nil
	}

	_, err := f.svc.SendMessage(context.Background(), "admin", "ch-1",
		&models.CreateDMMessageRequest{Content: "moderator note"})
	if err != nil {
		t.Fatalf("platform admin should bypass pending guard, got err: %v", err)
	}
	if !created {
		t.Errorf("CreateMessage was not called — admin path didn't reach persistence")
	}
}

func TestSendMessage_blockedSenderRejected(t *testing.T) {
	// Bidirectional block → forbidden. Regardless of pending/accepted
	// status, a blocked user cannot send.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, DMPrivacy: "accepted"}, nil
	}
	f.block.IsBlockedFn = func(_ context.Context, _, _ string) (bool, error) {
		return true, nil
	}

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "hi"})
	if err == nil {
		t.Fatal("expected block rejection")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("err chain missing ErrForbidden: %v", err)
	}
}

func TestSendMessage_blockedButPlatformAdminBypasses(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "admin", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, IsPlatformAdmin: id == "admin", DMPrivacy: "accepted"}, nil
	}
	f.block.IsBlockedFn = func(_ context.Context, _, _ string) (bool, error) {
		return true, nil
	}

	_, err := f.svc.SendMessage(context.Background(), "admin", "ch-1",
		&models.CreateDMMessageRequest{Content: "override"})
	if err != nil {
		t.Fatalf("admin should bypass block, got err: %v", err)
	}
}

func TestSendMessage_notAChannelMemberRejected(t *testing.T) {
	// carol isn't a member of alice+bob's channel — verifyChannelMembership
	// returns ErrForbidden.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}

	_, err := f.svc.SendMessage(context.Background(), "carol", "ch-1",
		&models.CreateDMMessageRequest{Content: "gate crash"})
	if err == nil {
		t.Fatal("non-member should not be able to send")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("err chain missing ErrForbidden: %v", err)
	}
}

func TestSendMessage_friendsOnlyBlocksNonFriend(t *testing.T) {
	// bob has DMPrivacy=friends_only; alice isn't his friend; forbidden.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		u := &models.User{ID: id, DMPrivacy: "accepted"}
		if id == "bob" {
			u.DMPrivacy = "friends_only"
		}
		return u, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) {
		return false, nil
	}

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "let me in"})
	if err == nil {
		t.Fatal("friends_only should block a non-friend")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("err chain missing ErrForbidden: %v", err)
	}
	if !strings.Contains(err.Error(), "friends") {
		t.Errorf("err = %q, want message referencing friends policy", err.Error())
	}
}

func TestSendMessage_acceptedFriendsSendSucceeds(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, DMPrivacy: "accepted"}, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) {
		return true, nil
	}

	created := false
	f.repo.CreateMessageFn = func(_ context.Context, _ *models.DMMessage) error {
		created = true
		return nil
	}

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "hi bob"})
	if err != nil {
		t.Fatalf("friends should send fine, got err: %v", err)
	}
	if !created {
		t.Errorf("CreateMessage not called on happy path")
	}
}

func TestSendMessage_firstMessageToMessageRequestUserTransitionsToPending(t *testing.T) {
	// bob has DMPrivacy=message_request; alice sends her FIRST message on
	// a still-accepted channel. Design: the first message is stored (so
	// bob has something to see when he opens the request UI) AND the
	// channel flips to pending so alice can't spam a second message
	// before bob accepts.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		u := &models.User{ID: id, DMPrivacy: "accepted"}
		if id == "bob" {
			u.DMPrivacy = "message_request"
		}
		return u, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) {
		return false, nil
	}
	f.repo.CountMessagesBySenderFn = func(_ context.Context, _, _ string) (int, error) {
		return 0, nil
	}
	updated := ""
	f.repo.UpdateChannelStatusFn = func(_ context.Context, _, status string) error {
		updated = status
		return nil
	}
	initiator := ""
	f.repo.SetInitiatedByFn = func(_ context.Context, _, userID string) error {
		initiator = userID
		return nil
	}
	created := false
	f.repo.CreateMessageFn = func(_ context.Context, _ *models.DMMessage) error {
		created = true
		return nil
	}

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "first message"})
	if err != nil {
		t.Fatalf("first message on message_request channel should succeed, got err: %v", err)
	}
	if !created {
		t.Error("CreateMessage not called — first request message wasn't stored")
	}
	if updated != models.DMStatusPending {
		t.Errorf("channel status update = %q, want %q", updated, models.DMStatusPending)
	}
	if initiator != "alice" {
		t.Errorf("SetInitiatedBy = %q, want %q", initiator, "alice")
	}
}

func TestSendMessage_secondMessageToMessageRequestUserBlocked(t *testing.T) {
	// Alice already sent one message on this message_request channel.
	// otherMsgCount==0 (bob hasn't replied) AND alice's msgCount>0 →
	// the branch at dm_message.go returns dm_request_pending. Prior
	// session flagged this as the guard that hardens the request flow
	// against spam-before-accept.
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		u := &models.User{ID: id, DMPrivacy: "accepted"}
		if id == "bob" {
			u.DMPrivacy = "message_request"
		}
		return u, nil
	}
	f.friends.AreFriendsFn = func(_ context.Context, _, _ string) (bool, error) { return false, nil }
	f.repo.CountMessagesBySenderFn = func(_ context.Context, _, sender string) (int, error) {
		if sender == "alice" {
			return 3, nil // alice has been talking
		}
		return 0, nil // bob hasn't replied
	}

	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "please respond"})
	if err == nil || !strings.Contains(err.Error(), "dm_request_pending") {
		t.Fatalf("expected dm_request_pending, got %v", err)
	}
}

// TestSendMessage_AuthorPayloadHasNoPII is the regression guard for the leak
// fixed by models.PublicUser (security scan 2026-07-31, finding N-09):
// dm_message.go used to embed the full author *models.User (only blanking
// PasswordHash) into the DM message response and WS broadcast payload,
// shipping email, admin/ban flags and other PII to the other DM participant.
func TestSendMessage_AuthorPayloadHasNoPII(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{
			ID: id, User1ID: "alice", User2ID: "bob",
			Status: models.DMStatusAccepted,
		}, nil
	}

	email := "alice@example.com"
	lastSeen := time.Now()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{
			ID:               id,
			Username:         "alice",
			DMPrivacy:        "accepted",
			Email:            &email,
			IsPlatformAdmin:  true,
			IsPlatformBanned: true,
			Language:         "tr",
			PrefStatus:       models.UserStatusOnline,
			LastSeenAt:       &lastSeen,
			PasswordHash:     "bcrypt-hash-should-never-appear",
		}, nil
	}

	msg, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{Content: "hi bob"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	body, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal DM message: %v", err)
	}
	leaked := []string{`"email"`, `"is_platform_admin"`, `"is_platform_banned"`, `"dm_privacy"`, `"language"`, `"last_seen_at"`, `"password`}
	for _, key := range leaked {
		if strings.Contains(string(body), key) {
			t.Errorf("DM message payload leaks PII field %s: %s", key, body)
		}
	}
}

func TestSendMessage_validateFailure_bubblesUpBadRequest(t *testing.T) {
	// Empty request (no content, no ciphertext, no files) → Validate error →
	// wrapped as ErrBadRequest.
	f := newDMFixture()
	_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1",
		&models.CreateDMMessageRequest{})
	if err == nil {
		t.Fatal("expected validation failure")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("err chain missing ErrBadRequest: %v", err)
	}
}
