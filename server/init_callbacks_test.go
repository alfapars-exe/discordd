package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type onlineFriendNotifierSpy struct {
	online  []string
	offline []string
	events  *[]string
}

func (s *onlineFriendNotifierSpy) NotifyOnline(_ context.Context, userID string) error {
	s.online = append(s.online, userID)
	if s.events != nil {
		*s.events = append(*s.events, "notify")
	}
	return nil
}

func (s *onlineFriendNotifierSpy) ObserveOffline(userID string) {
	s.offline = append(s.offline, userID)
	if s.events != nil {
		*s.events = append(*s.events, "observe-offline")
	}
}

type callbackVoiceStub struct{ services.VoiceService }

func (*callbackVoiceStub) GetUserVoiceState(string) *models.VoiceState { return nil }

type callbackP2PStub struct {
	services.P2PCallService
	handled int
}

func (s *callbackP2PStub) HandleDisconnect(string) { s.handled++ }

type presenceCallbackRepo struct {
	*testutil.MockUserRepo
	events    *[]string
	manualErr error
}

func (r *presenceCallbackRepo) UpdateManualPresence(context.Context, string, models.UserStatus) error {
	*r.events = append(*r.events, "update-manual-presence")
	return r.manualErr
}

func TestUserFirstConnectCallback_NotifiesOnlyFreshVisiblePersistedOnlineEdge(t *testing.T) {
	for _, tc := range []struct {
		name        string
		prefStatus  models.UserStatus
		writeErr    error
		reconnect   bool
		visible     bool
		wantNotices int
	}{
		{name: "fresh online", prefStatus: models.UserStatusOnline, visible: true, wantNotices: 1},
		{name: "invisible preference", prefStatus: models.UserStatusOffline, visible: false, wantNotices: 0},
		{name: "reconnect inside debounce grace", prefStatus: models.UserStatusOnline, reconnect: true, visible: true, wantNotices: 0},
		{name: "status write failed", prefStatus: models.UserStatusOnline, writeErr: errors.New("db unavailable"), visible: true, wantNotices: 0},
		{name: "not visible in hub", prefStatus: models.UserStatusOnline, visible: false, wantNotices: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spy := &onlineFriendNotifierSpy{}
			debouncer := newPresenceOfflineDebouncer(time.Hour)
			if tc.reconnect {
				debouncer.schedule("user-1", func(uint64) {})
			}
			hub := &testutil.MockEventPublisher{
				GetVisibleOnlineUserIDsFn: func() []string {
					if tc.visible {
						return []string{"user-1"}
					}
					return nil
				},
			}
			userRepo := &testutil.MockUserRepo{
				GetByIDFn: func(ctx context.Context, id string) (*models.User, error) {
					return &models.User{ID: id, PrefStatus: tc.prefStatus}, nil
				},
				UpdateStatusFn: func(context.Context, string, models.UserStatus) error { return tc.writeErr },
			}

			userFirstConnectCallback(hub, userRepo, debouncer, spy)("user-1", "")
			if len(spy.online) != tc.wantNotices {
				t.Fatalf("online notifications = %v, want count %d", spy.online, tc.wantNotices)
			}
		})
	}
}

func TestUserFirstConnectCallback_StatusWriteFailureDoesNotFanOut(t *testing.T) {
	broadcasts := 0
	spy := &onlineFriendNotifierSpy{}
	hub := &testutil.MockEventPublisher{
		GetVisibleOnlineUserIDsFn: func() []string { return []string{"user-1"} },
	}
	hub.BroadcastToAllFn = func(ws.Event) { broadcasts++ }
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "user-1", PrefStatus: models.UserStatusOnline}, nil
		},
		UpdateStatusFn: func(context.Context, string, models.UserStatus) error { return errors.New("db unavailable") },
	}

	userFirstConnectCallback(hub, userRepo, newPresenceOfflineDebouncer(time.Hour), spy)("user-1", "")

	if broadcasts != 0 || len(spy.online) != 0 || len(spy.offline) != 0 {
		t.Fatalf("status write failure fanned out: broadcasts=%d notices=%+v", broadcasts, spy)
	}
}

func TestUserFirstConnectCallback_MissingUserDoesNotFanOut(t *testing.T) {
	broadcasts := 0
	spy := &onlineFriendNotifierSpy{}
	hub := &testutil.MockEventPublisher{}
	hub.BroadcastToAllFn = func(ws.Event) { broadcasts++ }
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(context.Context, string) (*models.User, error) { return nil, nil },
	}

	userFirstConnectCallback(hub, userRepo, newPresenceOfflineDebouncer(time.Hour), spy)("user-1", "")

	if broadcasts != 0 || len(spy.online) != 0 || len(spy.offline) != 0 {
		t.Fatalf("missing user fanned out: broadcasts=%d notices=%+v", broadcasts, spy)
	}
}

func TestUserFullyDisconnectedCallbackDoesNotClearHubOwnedInvisibleFlag(t *testing.T) {
	setInvisibleCalls := 0
	hub := &testutil.MockEventPublisher{
		SetInvisibleFn: func(string, bool) { setInvisibleCalls++ },
	}
	debouncer := newPresenceOfflineDebouncer(time.Hour)
	defer debouncer.stopAll()
	p2p := &callbackP2PStub{}

	userFullyDisconnectedCallback(hub, &testutil.MockUserRepo{}, &callbackVoiceStub{}, p2p, debouncer)("user-1", "")

	if setInvisibleCalls != 0 {
		t.Fatalf("async disconnect callback mutated Hub-owned visibility %d times", setInvisibleCalls)
	}
	if p2p.handled != 1 {
		t.Fatalf("P2P disconnect cleanup calls=%d, want 1", p2p.handled)
	}
}

func TestOfflinePresenceTransitionNotifiesOnlyAfterCurrentSuccessfulOfflineWrite(t *testing.T) {
	for _, tc := range []struct {
		name     string
		gen      uint64
		writeErr error
		want     int
	}{
		{name: "current successful offline write", gen: 1, want: 1},
		{name: "stale generation", gen: 99, want: 0},
		{name: "failed offline write", gen: 1, writeErr: errors.New("db unavailable"), want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spy := &onlineFriendNotifierSpy{}
			debouncer := newPresenceOfflineDebouncer(time.Hour)
			if tc.gen == 1 {
				debouncer.schedule("user-1", func(uint64) {})
			}
			hub := &testutil.MockEventPublisher{GetOnlineUserIDsFn: func() []string { return nil }}
			userRepo := &testutil.MockUserRepo{
				UpdateStatusFn: func(context.Context, string, models.UserStatus) error { return tc.writeErr },
			}
			offlinePresenceTransition(hub, userRepo, debouncer, "user-1", tc.gen, spy)
			if len(spy.offline) != tc.want {
				t.Fatalf("offline observations = %v, want count %d", spy.offline, tc.want)
			}
		})
	}
}

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
		GetByIDFn: func(ctx context.Context, id string) (*models.User, error) {
			assertBounded(t, ctx, "userRepo.GetByID for auto presence")
			return &models.User{ID: id, PrefStatus: models.UserStatusOnline}, nil
		},
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

func TestPresenceUpdateCallback_ManualVisibleTransitionNotifiesAfterVisibilityChange(t *testing.T) {
	events := []string{}
	invisible := true
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn: func() []string { return []string{"user-1"} },
		IsInvisibleFn:      func(string) bool { return invisible },
		GetVisibleOnlineUserIDsFn: func() []string {
			if invisible {
				return nil
			}
			return []string{"user-1"}
		},
		CommitPresenceVisibilityFn: func(_ string, status string) bool {
			value := status == string(models.UserStatusOffline)
			invisible = value
			if value {
				events = append(events, "commit-invisible")
			} else {
				events = append(events, "commit-visible")
			}
			return true
		},
	}
	hub.BroadcastToAllFn = func(ws.Event) { events = append(events, "broadcast") }
	userRepo := &presenceCallbackRepo{MockUserRepo: &testutil.MockUserRepo{}, events: &events}
	spy := &onlineFriendNotifierSpy{events: &events}

	presenceUpdateCallback(hub, userRepo, spy)("user-1", string(models.UserStatusIdle), false)

	if invisible || len(spy.online) != 1 || spy.online[0] != "user-1" || len(spy.offline) != 0 {
		t.Fatalf("visibility=%v online=%v offline=%v", invisible, spy.online, spy.offline)
	}
	want := []string{"update-manual-presence", "commit-visible", "broadcast", "notify"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events=%v, want %v", events, want)
	}
}

func TestPresenceUpdateCallback_AutoPresenceRequiresOnlinePreferenceAndMarksPayload(t *testing.T) {
	for _, tc := range []struct {
		name       string
		pref       models.UserStatus
		lookupErr  error
		wantUpdate bool
	}{
		{name: "online preference permits auto idle", pref: models.UserStatusOnline, wantUpdate: true},
		{name: "DND preference blocks queued auto idle", pref: models.UserStatusDND},
		{name: "offline preference blocks auto idle", pref: models.UserStatusOffline},
		{name: "lookup failure fails closed", pref: models.UserStatusOnline, lookupErr: errors.New("database unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			updates, broadcasts := 0, 0
			var payload ws.PresenceData
			hub := &testutil.MockEventPublisher{
				IsInvisibleFn: func(string) bool { return false },
			}
			hub.BroadcastToAllFn = func(event ws.Event) {
				broadcasts++
				payload = event.Data.(ws.PresenceData)
			}
			userRepo := &testutil.MockUserRepo{
				GetByIDFn: func(context.Context, string) (*models.User, error) {
					return &models.User{ID: "user-1", PrefStatus: tc.pref}, tc.lookupErr
				},
				UpdateStatusFn: func(context.Context, string, models.UserStatus) error {
					updates++
					return nil
				},
			}

			presenceUpdateCallback(hub, userRepo)("user-1", string(models.UserStatusIdle), true)

			if tc.wantUpdate {
				if updates != 1 || broadcasts != 1 || !payload.IsAuto || payload.Status != string(models.UserStatusIdle) {
					t.Fatalf("updates=%d broadcasts=%d payload=%+v", updates, broadcasts, payload)
				}
			} else if updates != 0 || broadcasts != 0 {
				t.Fatalf("auto update was not suppressed: updates=%d broadcasts=%d", updates, broadcasts)
			}
		})
	}
}

func TestPresenceUpdateCallback_ManualInvisibleResetsEpochAfterHiding(t *testing.T) {
	events := []string{}
	invisible := false
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn:        func() []string { return []string{"user-1"} },
		GetVisibleOnlineUserIDsFn: func() []string { return []string{"user-1"} },
		CommitPresenceVisibilityFn: func(_ string, status string) bool {
			value := status == string(models.UserStatusOffline)
			invisible = value
			events = append(events, "commit-invisible")
			return true
		},
	}
	hub.BroadcastToAllFn = func(ws.Event) { events = append(events, "broadcast") }
	userRepo := &presenceCallbackRepo{MockUserRepo: &testutil.MockUserRepo{}, events: &events}
	spy := &onlineFriendNotifierSpy{events: &events}

	presenceUpdateCallback(hub, userRepo, spy)("user-1", string(models.UserStatusOffline), false)

	if !invisible || len(spy.offline) != 1 || spy.offline[0] != "user-1" || len(spy.online) != 0 {
		t.Fatalf("visibility=%v online=%v offline=%v", invisible, spy.online, spy.offline)
	}
	want := []string{"update-manual-presence", "commit-invisible", "broadcast", "observe-offline"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events=%v, want %v", events, want)
	}
}

func TestPresenceUpdateCallback_AutoIdleDoesNotRevealInvisibleUser(t *testing.T) {
	invisible := true
	updates, broadcasts := 0, 0
	hub := &testutil.MockEventPublisher{
		IsInvisibleFn:      func(string) bool { return invisible },
		GetOnlineUserIDsFn: func() []string { return []string{"user-1"} },
		GetVisibleOnlineUserIDsFn: func() []string {
			if invisible {
				return nil
			}
			return []string{"user-1"}
		},
		SetInvisibleFn: func(_ string, value bool) { invisible = value },
	}
	hub.BroadcastToAllFn = func(ws.Event) { broadcasts++ }
	userRepo := &testutil.MockUserRepo{UpdateStatusFn: func(context.Context, string, models.UserStatus) error {
		updates++
		return nil
	}}
	spy := &onlineFriendNotifierSpy{}

	presenceUpdateCallback(hub, userRepo, spy)("user-1", string(models.UserStatusIdle), true)

	if !invisible || updates != 0 || broadcasts != 0 || len(spy.online)+len(spy.offline) != 0 {
		t.Fatalf("invisible=%v status_updates=%d broadcasts=%d notices=%+v", invisible, updates, broadcasts, spy)
	}
}

func TestPresenceUpdateCallback_PreferenceWriteFailureDoesNotChangeVisibilityOrFanOut(t *testing.T) {
	events := []string{}
	hub := &testutil.MockEventPublisher{
		GetOnlineUserIDsFn:         func() []string { return []string{"user-1"} },
		GetVisibleOnlineUserIDsFn:  func() []string { return nil },
		CommitPresenceVisibilityFn: func(string, string) bool { events = append(events, "visibility"); return true },
	}
	hub.BroadcastToAllFn = func(ws.Event) { events = append(events, "broadcast") }
	userRepo := &presenceCallbackRepo{MockUserRepo: &testutil.MockUserRepo{}, events: &events, manualErr: errors.New("db unavailable")}
	spy := &onlineFriendNotifierSpy{}

	presenceUpdateCallback(hub, userRepo, spy)("user-1", string(models.UserStatusOnline), false)

	if !reflect.DeepEqual(events, []string{"update-manual-presence"}) || len(spy.online)+len(spy.offline) != 0 {
		t.Fatalf("events=%v notices=%+v; expected fail-closed callback", events, spy)
	}
}

func TestPresenceUpdateCallback_SupersededVisibilityCommitDoesNotFanOut(t *testing.T) {
	broadcasts, commits := 0, 0
	hub := &testutil.MockEventPublisher{
		CommitPresenceVisibilityFn: func(string, string) bool {
			commits++
			return false
		},
	}
	hub.BroadcastToAllFn = func(ws.Event) { broadcasts++ }
	spy := &onlineFriendNotifierSpy{}

	presenceUpdateCallback(hub, &testutil.MockUserRepo{}, spy)("user-1", string(models.UserStatusOnline), false)

	if commits != 1 || broadcasts != 0 || len(spy.online)+len(spy.offline) != 0 {
		t.Fatalf("commit=%d broadcasts=%d notices=%+v; stale visibility commit must be suppressed", commits, broadcasts, spy)
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
