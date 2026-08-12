package main

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Hub callbacks run on goroutines the Hub spawns and abandons — nothing joins
// them, so a repository call made under an unbounded context.Background() pins
// that goroutine for as long as the database stays wedged. These tests assert
// the contract that prevents it: every repository call a callback makes must
// carry a deadline.
//
// The assertion is deliberately on ctx.Deadline() rather than on the exact
// timeout, so retuning services.BroadcastContext() doesn't break them; the
// upper bound below only catches a context that is bounded in name only.

// assertBounded fails unless ctx carries a deadline that is still in the
// future and inside a sane ceiling.
func assertBounded(t *testing.T, ctx context.Context, site string) {
	t.Helper()

	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatalf("%s: context has no deadline — an unbounded context here leaks the callback goroutine when the DB stalls", site)
	}

	remaining := time.Until(deadline)
	if remaining <= 0 {
		t.Fatalf("%s: context deadline already expired (%v ago)", site, -remaining)
	}
	if remaining > time.Minute {
		t.Fatalf("%s: context deadline is %v away — too loose to bound a wedged connection", site, remaining)
	}
}

func TestUserFirstConnectCallback_PassesBoundedContextToRepo(t *testing.T) {
	var sawGetByID, sawUpdateStatus bool

	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.User, error) {
			sawGetByID = true
			assertBounded(t, ctx, "userRepo.GetByID")
			return &models.User{ID: id, PrefStatus: models.UserStatusOnline}, nil
		},
		UpdateStatusFn: func(ctx context.Context, _ string, _ models.UserStatus) error {
			sawUpdateStatus = true
			assertBounded(t, ctx, "userRepo.UpdateStatus")
			return nil
		},
	}

	userFirstConnectCallback(ws.NewHub(), userRepo, newPresenceOfflineDebouncer(time.Minute))("user-1", "")

	if !sawGetByID {
		t.Error("callback never called userRepo.GetByID")
	}
	if !sawUpdateStatus {
		t.Error("callback never called userRepo.UpdateStatus")
	}
}

func TestPresenceUpdateCallback_PassesBoundedContextToRepo(t *testing.T) {
	var sawUpdateStatus bool

	userRepo := &testutil.MockUserRepo{
		UpdateStatusFn: func(ctx context.Context, _ string, _ models.UserStatus) error {
			sawUpdateStatus = true
			assertBounded(t, ctx, "userRepo.UpdateStatus")
			return nil
		},
	}

	// isAuto=true: the auto-idle path, which is the one the Hub fires on every
	// extra tab connect/disconnect and therefore the highest-volume caller.
	presenceUpdateCallback(ws.NewHub(), userRepo)("user-1", string(models.UserStatusIdle), true)

	if !sawUpdateStatus {
		t.Fatal("callback never called userRepo.UpdateStatus")
	}
}

func TestDMTypingCallback_PassesBoundedContextToRepo(t *testing.T) {
	var sawGetChannel bool

	dmRepo := &testutil.MockDMRepo{
		GetChannelByIDFn: func(ctx context.Context, id string) (*models.DMChannel, error) {
			sawGetChannel = true
			assertBounded(t, ctx, "dmRepo.GetChannelByID")
			return &models.DMChannel{ID: id, User1ID: "user-1", User2ID: "user-2"}, nil
		},
	}

	dmTypingCallback(ws.NewHub(), dmRepo)("user-1", "alice", "dm-1")

	if !sawGetChannel {
		t.Fatal("callback never called dmRepo.GetChannelByID")
	}
}

// The bound must also survive the callback returning early. First-connect
// bails out before UpdateStatus when the user is invisible; the read that
// precedes that branch still has to be bounded.
func TestUserFirstConnectCallback_BoundsContextOnInvisiblePath(t *testing.T) {
	var sawGetByID bool

	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.User, error) {
			sawGetByID = true
			assertBounded(t, ctx, "userRepo.GetByID (invisible path)")
			return &models.User{ID: id, PrefStatus: models.UserStatusOffline}, nil
		},
		UpdateStatusFn: func(_ context.Context, _ string, _ models.UserStatus) error {
			t.Error("invisible user should not have their status written")
			return nil
		},
	}

	userFirstConnectCallback(ws.NewHub(), userRepo, newPresenceOfflineDebouncer(time.Minute))("user-1", "")

	if !sawGetByID {
		t.Fatal("callback never called userRepo.GetByID")
	}
}

// ─── channelTypingCallback: sender permission gate (P1.2) ───

const (
	fullReadPerms = models.PermViewChannel | models.PermReadMessages
	noReadPerms   = models.PermConnectVoice // any bit that isn't View+Read
)

func TestChannelTypingCallback_UnauthorizedSenderProducesNoBroadcast(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "server-1"}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsBulkFn: func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
			// Sender is in the online set but lacks read access.
			return map[string]models.Permission{"sender-1": noReadPerms, "listener-1": fullReadPerms}, nil
		},
	}
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsForServerFn: func(serverID string) []string { return []string{"sender-1", "listener-1"} },
	}
	hub.BroadcastToUsersFn = func(userIDs []string, event ws.Event) {
		t.Fatalf("unauthorized sender must not produce a broadcast, got recipients %v", userIDs)
	}

	channelTypingCallback(hub, channelRepo, permResolver)("sender-1", "sender", "chan-1")
}

func TestChannelTypingCallback_AuthorizedSenderBroadcastsToPermittedRecipientsOnly(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "server-1"}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsBulkFn: func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
			return map[string]models.Permission{
				"sender-1":     fullReadPerms,
				"listener-ok":  fullReadPerms,
				"listener-bad": noReadPerms,
			}, nil
		},
	}
	var gotRecipients []string
	var broadcastCount int
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsForServerFn: func(serverID string) []string {
			return []string{"sender-1", "listener-ok", "listener-bad"}
		},
	}
	hub.BroadcastToUsersFn = func(userIDs []string, event ws.Event) {
		broadcastCount++
		gotRecipients = userIDs
	}

	channelTypingCallback(hub, channelRepo, permResolver)("sender-1", "sender", "chan-1")

	if broadcastCount != 1 {
		t.Fatalf("expected exactly one broadcast, got %d", broadcastCount)
	}
	if len(gotRecipients) != 1 || gotRecipients[0] != "listener-ok" {
		t.Fatalf("expected recipients [listener-ok], got %v", gotRecipients)
	}
}

// Sender absent from the bulk snapshot (e.g. connected between the online-
// user query and this event) must fall back to an individual resolve rather
// than being silently trusted.
func TestChannelTypingCallback_SenderNotInBulk_ResolvesIndividually(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "server-1"}, nil
		},
	}
	var sawIndividualResolve bool
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsBulkFn: func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
			return map[string]models.Permission{"listener-ok": fullReadPerms}, nil // sender-1 absent
		},
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			if userID == "sender-1" {
				sawIndividualResolve = true
				return fullReadPerms, nil
			}
			return 0, nil
		},
	}
	var broadcastCount int
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsForServerFn: func(serverID string) []string { return []string{"listener-ok"} },
	}
	hub.BroadcastToUsersFn = func(userIDs []string, event ws.Event) { broadcastCount++ }

	channelTypingCallback(hub, channelRepo, permResolver)("sender-1", "sender", "chan-1")

	if !sawIndividualResolve {
		t.Fatal("expected an individual ResolveChannelPermissions call for a sender missing from the bulk snapshot")
	}
	if broadcastCount != 1 {
		t.Fatalf("expected exactly one broadcast once the individual resolve grants read access, got %d", broadcastCount)
	}
}

// A sender resolve error must fail closed (no broadcast), not fail open.
func TestChannelTypingCallback_SenderResolveError_NoBroadcast(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(ctx context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "server-1"}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsBulkFn: func(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
			return map[string]models.Permission{"listener-ok": fullReadPerms}, nil // sender-1 absent
		},
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return 0, context.DeadlineExceeded
		},
	}
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsForServerFn: func(serverID string) []string { return []string{"listener-ok"} },
	}
	hub.BroadcastToUsersFn = func(userIDs []string, event ws.Event) {
		t.Fatalf("a sender permission resolve error must fail closed, got broadcast to %v", userIDs)
	}

	channelTypingCallback(hub, channelRepo, permResolver)("sender-1", "sender", "chan-1")
}
