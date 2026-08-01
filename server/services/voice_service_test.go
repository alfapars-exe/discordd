package services

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// mockLiveKitGetter returns error so removeParticipantFromLiveKit goroutine exits early.
type mockLiveKitGetter struct{}

func (m *mockLiveKitGetter) GetByServerID(_ context.Context, _ string) (*models.LiveKitInstance, error) {
	return nil, fmt.Errorf("no livekit instance in test")
}

func (m *mockLiveKitGetter) GetMonthlyUsage(_ context.Context, _ string, _, _ int) (int64, error) {
	return 0, nil
}

func (m *mockLiveKitGetter) IncrementMonthlyUsage(_ context.Context, _ string, _, _, _ int) error {
	return nil
}

func (m *mockLiveKitGetter) GetNextAutoSwitchInstance(_ context.Context, _ string, _, _ int) (*models.LiveKitInstance, error) {
	return nil, nil
}

func (m *mockLiveKitGetter) MigrateOneServer(_ context.Context, _, _ string) error {
	return nil
}

// newTestVoiceService wires happy-path defaults: caller is a server member
// with every permission (PermAll), so the N-01 authorization gate added to
// JoinChannel doesn't have to be re-satisfied by every pre-existing test in
// this package. Tests that specifically exercise the gate (denied/allowed
// paths) build their own harness — see TestVoiceJoinChannel_Authorization*.
func newTestVoiceService() (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				return true, nil
			},
		}, // afkTimeoutGetter — also backs the N-01 membership check
		nil, // encryptionKey
		nil, // timeoutChecker — nil here is intentional; see TestVoiceJoinChannel_NilTimeoutChecker_Allows. Production always passes repos.MemberTimeout.
		nil, // banChecker — same rationale
	)
	return svc, hub
}

// newTestVoiceServiceWithTimeoutChecker is newTestVoiceService plus an
// explicit MemberTimeoutChecker, for the timeout-gate tests below.
// timeoutChecker moved from a post-construction setter to a constructor
// param (A-29b), so these tests build the checker in rather than calling
// a setter afterward.
func newTestVoiceServiceWithTimeoutChecker(checker MemberTimeoutChecker) (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				return true, nil
			},
		},
		nil, // encryptionKey
		checker,
		nil, // banChecker — not under test here
	)
	return svc, hub
}

// newTestVoiceServiceWithModeration is newTestVoiceService plus explicit
// MemberTimeoutChecker, BanChecker and ChannelGetter, for
// TestEnforceModerationOnJoin* below (A-29a). Either checker may be nil.
// channelRepo is injectable (not the shared happy-path default) so tests
// can observe eviction dispatch — see newEvictionObservingChannelRepo.
func newTestVoiceServiceWithModeration(timeoutChecker MemberTimeoutChecker, banChecker BanChecker, channelRepo ChannelGetter) (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		channelRepo,
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				return true, nil
			},
		},
		nil, // encryptionKey
		timeoutChecker,
		banChecker,
	)
	return svc, hub
}

// mockBanChecker is a function-field BanChecker mock, matching the
// testutil.MockMemberTimeoutRepo convention used for the sibling checker.
type mockBanChecker struct {
	ExistsFn func(ctx context.Context, serverID, userID string) (bool, error)
}

func (m *mockBanChecker) Exists(ctx context.Context, serverID, userID string) (bool, error) {
	return m.ExistsFn(ctx, serverID, userID)
}

// newEvictionObservingChannelRepo returns a ChannelGetter that behaves like
// the happy-path default (srv1/ch1, voice channel) but also pushes onto
// calls every time GetByID runs — the first step inside
// removeParticipantFromLiveKit (voice_lifecycle.go). EnforceModerationOnJoin
// dispatches eviction as `go removeParticipantAndScreenShareFromLiveKit`,
// which calls removeParticipantFromLiveKit once per identity (userID, then
// userID+"_ss") — so two GetByID calls is the observable proxy for "both
// identities were dispatched for eviction" without a real LiveKit server.
// Buffered generously so a positive-case test can never block on the send
// side even if a future change adds more identities.
func newEvictionObservingChannelRepo(calls chan string) *testutil.MockChannelRepo {
	return &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			calls <- id
			return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
		},
	}
}

// expectEvictionDispatches waits for exactly want GetByID calls on calls
// (see newEvictionObservingChannelRepo), failing the test if fewer arrive
// within the timeout or if an unexpected extra one shows up shortly after.
func expectEvictionDispatches(t *testing.T, calls chan string, want int) {
	t.Helper()
	for i := 0; i < want; i++ {
		select {
		case <-calls:
		case <-time.After(2 * time.Second):
			t.Fatalf("expected %d eviction dispatch(es), got %d before timing out", want, i)
		}
	}
	select {
	case extra := <-calls:
		t.Errorf("unexpected extra eviction dispatch for channel %q (wanted exactly %d)", extra, want)
	case <-time.After(100 * time.Millisecond):
	}
}

// expectNoEvictionDispatch asserts removeParticipantFromLiveKit's first
// step (GetByID) never runs — i.e. EnforceModerationOnJoin decided not to
// evict at all.
func expectNoEvictionDispatch(t *testing.T, calls chan string) {
	t.Helper()
	select {
	case got := <-calls:
		t.Errorf("expected no eviction dispatch, got GetByID(%q)", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// drainCalls discards whatever is already buffered on calls without
// blocking. Used to clear a test setup step's own GetByID call(s) (e.g. the
// initial JoinChannel that puts a user in voice before the action under
// test runs) so a later expectEvictionDispatches only counts the action's
// own dispatches.
func drainCalls(calls chan string) {
	for {
		select {
		case <-calls:
		default:
			return
		}
	}
}

// newTestVoiceServiceWithChannelRepo is newTestVoiceService with an
// injectable ChannelGetter (instead of the fixed happy-path default) and a
// real (non-nil) OnlineUserChecker defaulting to "nobody online" — needed
// for sweepOrphanStates, which dereferences onlineChecker unconditionally.
// Used by the A-29d admin-path / cross-channel-switch / orphan-sweep
// dispatch tests below, extending the same injection pattern
// newTestVoiceServiceWithModeration already uses for EnforceModerationOnJoin.
func newTestVoiceServiceWithChannelRepo(channelRepo ChannelGetter) (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		channelRepo,
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		&testutil.MockBroadcastAndOnline{}, // onlineChecker — nobody online by default
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				return true, nil
			},
		},
		nil, // encryptionKey
		nil, // timeoutChecker — not under test here
		nil, // banChecker — not under test here
	)
	return svc, hub
}

// ─── A-29d: dual-identity eviction — remaining single-identity call sites ───
//
// EnforceModerationOnJoin's tests above already pin the dual-identity
// contract itself; these pin that the other four call sites this session
// converted from removeParticipantFromLiveKit to
// removeParticipantAndScreenShareFromLiveKit actually dispatch it, using
// the same newEvictionObservingChannelRepo/expectEvictionDispatches
// mechanism. Each test drains its own setup call(s) (JoinChannel's initial
// channel lookup, and — for MoveUser / cross-channel JoinChannel — the
// action's own synchronous target-channel lookup) before asserting exactly
// 2 dispatches for the room being vacated.

// TestAdminDisconnectUser_EvictsMainAndScreenShare pins the MEDIUM finding's
// primary fix: force-disconnecting a user must not leave their screen share
// running. AdminDisconnectUser makes no synchronous channelGetter call of
// its own, so no extra drain is needed between the setup join and the
// dispatch count.
func TestAdminDisconnectUser_EvictsMainAndScreenShare(t *testing.T) {
	calls := make(chan string, 8)
	svc, hub := newTestVoiceServiceWithChannelRepo(newEvictionObservingChannelRepo(calls))
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls) // discard JoinChannel's own channel lookup

	if err := svc.AdminDisconnectUser(context.Background(), "admin", "victim"); err != nil {
		t.Fatalf("AdminDisconnectUser: %v", err)
	}
	expectEvictionDispatches(t, calls, 2)
}

// TestMoveUser_EvictsSourceRoomMainAndScreenShare pins that moving a user to
// a new channel evicts both identities from the OLD (source) room — a
// screen share does not follow the user to the new room on its own.
func TestMoveUser_EvictsSourceRoomMainAndScreenShare(t *testing.T) {
	calls := make(chan string, 8)
	svc, hub := newTestVoiceServiceWithChannelRepo(newEvictionObservingChannelRepo(calls))
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls)

	if err := svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}

	// MoveUser's own synchronous target-channel lookup (ch2, at the very top
	// of MoveUser) lands before the async source-room eviction dispatches —
	// discard it first so expectEvictionDispatches counts only ch1.
	select {
	case got := <-calls:
		if got != "ch2" {
			t.Errorf("expected MoveUser's own target-channel lookup (ch2) first, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("MoveUser's target-channel lookup never happened")
	}
	expectEvictionDispatches(t, calls, 2)
}

// TestJoinChannel_CrossChannelSwitch_EvictsOldRoomMainAndScreenShare pins
// that switching voice channels evicts both identities from the OLD room —
// the fresh VoiceState JoinChannel builds for the new channel doesn't carry
// IsStreaming forward, but the LiveKit "_ss" connection itself is untouched
// by this call and needs the same best-effort cleanup as the main identity.
func TestJoinChannel_CrossChannelSwitch_EvictsOldRoomMainAndScreenShare(t *testing.T) {
	calls := make(chan string, 8)
	svc, hub := newTestVoiceServiceWithChannelRepo(newEvictionObservingChannelRepo(calls))
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls) // discard the first join's own channel lookup (ch1)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("cross-channel join failed: %v", err)
	}

	// The second JoinChannel's own synchronous lookup (ch2, the NEW channel)
	// lands before the async old-room eviction dispatches — discard it first.
	select {
	case got := <-calls:
		if got != "ch2" {
			t.Errorf("expected the new join's own channel lookup (ch2) first, got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the new join's channel lookup never happened")
	}
	expectEvictionDispatches(t, calls, 2)
}

// TestOrphanSweep_EvictsMainAndScreenShare pins that a swept-up abandoned
// voice session evicts both identities — s.states (what orphanEntry.userID
// is drawn from) has no entry of its own for a "_ss" sub-participant, so
// without this fix an abandoned screen share would linger until LiveKit's
// own ICE/DTLS timeout instead of being cleaned up by the janitor that
// exists precisely to avoid that for the main identity.
func TestOrphanSweep_EvictsMainAndScreenShare(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithChannelRepo(newEvictionObservingChannelRepo(calls))
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box orphan-sweep access")
	}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls)

	// Simulate the grace period having already elapsed, so one sweep pass
	// evicts immediately instead of only starting the offline-tracking
	// timer (see sweepOrphanStates' two-phase design).
	vs.mu.Lock()
	vs.offlineSince["victim"] = time.Now().Add(-orphanGracePeriod - time.Second)
	vs.mu.Unlock()

	vs.sweepOrphanStates()

	expectEvictionDispatches(t, calls, 2)
}

// ─── A-29a: EnforceModerationOnJoin (LiveKit webhook moderation backstop) ───

// TestEnforceModerationOnJoin_TimedOut_RemovesParticipant pins the timeout
// half: an active timeout evicts the participant. Asserts exactly 2
// eviction dispatches (main voice identity + "_ss" screen-share
// sub-participant, see removeParticipantAndScreenShareFromLiveKit) —
// mockLiveKitGetter still errors past the channel lookup, so this doesn't
// reach a real LiveKit call, but it does prove the gate actually dispatches
// eviction for both identities rather than only deciding to.
func TestEnforceModerationOnJoin_TimedOut_RemovesParticipant(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, serverID, userID string) (bool, error) {
				if serverID != "srv1" || userID != "u1" {
					t.Errorf("IsActive called with unexpected args: %s %s", serverID, userID)
				}
				return true, nil
			},
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, _, _ string) (bool, error) {
				t.Error("ban check must not run once the timeout check already found an active timeout")
				return false, nil
			},
		},
		newEvictionObservingChannelRepo(calls),
	)
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	expectEvictionDispatches(t, calls, 2)
}

// TestEnforceModerationOnJoin_Banned_RemovesParticipant pins the ban half,
// checked only when the timeout checker found no active timeout, and again
// asserts exactly 2 eviction dispatches.
func TestEnforceModerationOnJoin_Banned_RemovesParticipant(t *testing.T) {
	var timeoutChecked, banChecked bool
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
				timeoutChecked = true
				return false, nil
			},
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, serverID, userID string) (bool, error) {
				banChecked = true
				if serverID != "srv1" || userID != "u1" {
					t.Errorf("Exists called with unexpected args: %s %s", serverID, userID)
				}
				return true, nil
			},
		},
		newEvictionObservingChannelRepo(calls),
	)
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	if !timeoutChecked || !banChecked {
		t.Errorf("expected both checks to run, timeoutChecked=%v banChecked=%v", timeoutChecked, banChecked)
	}
	expectEvictionDispatches(t, calls, 2)
}

// TestEnforceModerationOnJoin_NotModerated_NoOp pins the negative case: a
// user who is neither timed out nor banned triggers no eviction dispatch at
// all — the channel repo's GetByID (removeParticipantFromLiveKit's first
// step) never runs.
func TestEnforceModerationOnJoin_NotModerated_NoOp(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
				return false, nil
			},
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, _, _ string) (bool, error) {
				return false, nil
			},
		},
		newEvictionObservingChannelRepo(calls),
	)
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	expectNoEvictionDispatch(t, calls)
}

// TestEnforceModerationOnJoin_CheckerError_FailsOpen pins the documented
// fail-open decision: a checker error is logged, not treated as
// "moderated" — the primary join-time gates already fail closed on a real
// timeout/ban, so this backstop failing open on a transient DB error avoids
// evicting innocent participants. No eviction dispatch happens.
func TestEnforceModerationOnJoin_CheckerError_FailsOpen(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
				return false, fmt.Errorf("timeout store unavailable")
			},
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, _, _ string) (bool, error) {
				return false, fmt.Errorf("ban store unavailable")
			},
		},
		newEvictionObservingChannelRepo(calls),
	)
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	expectNoEvictionDispatch(t, calls)
}

// TestEnforceModerationOnJoin_NilCheckers_NoOp pins that a voiceService
// constructed without either checker (nil, nil) does not panic and does not
// evict — mirrors TestVoiceJoinChannel_NilTimeoutChecker_Allows for this
// entry point.
func TestEnforceModerationOnJoin_NilCheckers_NoOp(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(nil, nil, newEvictionObservingChannelRepo(calls))
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	expectNoEvictionDispatch(t, calls)
}

// newAuthVoiceService builds a voiceService harness with a configurable
// membership flag and permission resolver, for tests that specifically
// exercise JoinChannel's N-01 authorization gate. See newTestVoiceService's
// doc comment for the happy-path default used by every other test here.
func newAuthVoiceService(isMember bool, resolvePerms func(ctx context.Context, userID, channelID string) (models.Permission, error)) (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockLiveKitGetter{},
		&testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: resolvePerms},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				return isMember, nil
			},
		},
		nil, // encryptionKey
		nil, // timeoutChecker — not under test here
		nil, // banChecker — not under test here
	)
	return svc, hub
}

// ─── N-01: JoinChannel authorization gate ───

// TestVoiceJoinChannel_Authorization_NonMemberRejected pins the core N-01
// fix: a WS client can no longer inject voice state for a server it never
// joined. GetChannelParticipants staying empty and zero broadcasts prove
// nothing was injected — a returned error alone wouldn't rule out a
// state leak that happened before the error was produced.
func TestVoiceJoinChannel_Authorization_NonMemberRejected(t *testing.T) {
	svc, hub := newAuthVoiceService(false, func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermAll, nil
	})
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("intruder", "intruder", "Intruder", "", "ch1", false, false)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 0 {
		t.Errorf("expected 0 participants after rejected join, got %d", len(participants))
	}
	if len(broadcasts) != 0 {
		t.Errorf("expected 0 broadcasts after rejected join, got %d", len(broadcasts))
	}
}

// TestVoiceJoinChannel_Authorization_MissingConnectVoiceRejected covers the
// second half of the gate: server membership alone isn't enough — the
// channel-level PermConnectVoice check must also hold.
func TestVoiceJoinChannel_Authorization_MissingConnectVoiceRejected(t *testing.T) {
	svc, hub := newAuthVoiceService(true, func(_ context.Context, _, _ string) (models.Permission, error) {
		// PermSendMessages only — deliberately excludes both PermConnectVoice
		// and PermAdmin (Has() gives Admin an all-permissions bypass, so
		// PermAll&^PermConnectVoice would still pass the check we're testing).
		return models.PermSendMessages, nil
	})
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 0 {
		t.Errorf("expected 0 participants after rejected join, got %d", len(participants))
	}
	if len(broadcasts) != 0 {
		t.Errorf("expected 0 broadcasts after rejected join, got %d", len(broadcasts))
	}
}

// TestVoiceJoinChannel_Authorization_PermittedMemberJoins proves the gate
// isn't a blanket deny: a real member with PermConnectVoice still joins and
// still gets its broadcast.
func TestVoiceJoinChannel_Authorization_PermittedMemberJoins(t *testing.T) {
	svc, hub := newAuthVoiceService(true, func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermConnectVoice, nil
	})
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 1 {
		t.Errorf("expected 1 participant after permitted join, got %d", len(participants))
	}
	if len(broadcasts) != 1 {
		t.Errorf("expected 1 broadcast after permitted join, got %d", len(broadcasts))
	}
}

// TestVoiceJoinChannel_Authorization_ForceMoveGrantAllowsJoin is the
// carve-out regression pin: an admin-moved user who lacks PermConnectVoice
// on the destination channel must still be able to (re)join it — otherwise
// MoveUser's force-move immediately breaks the moved user's own voice
// session. The grant is checked (not consumed) here; GenerateToken
// (voice_token.go) remains the single consumption point.
func TestVoiceJoinChannel_Authorization_ForceMoveGrantAllowsJoin(t *testing.T) {
	ctx := context.Background()
	svc, hub := newAuthVoiceService(true, func(_ context.Context, userID, channelID string) (models.Permission, error) {
		if userID == "victim" && channelID == "ch2" {
			return 0, nil // no ConnectVoice in the admin-only destination channel
		}
		return models.PermAll, nil
	})
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	// Victim starts in ch1, where they have full permissions.
	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("victim initial join failed: %v", err)
	}

	// Admin force-moves victim into ch2 — victim has no ConnectVoice there,
	// but MoveUser only requires the mover to hold PermMoveMembers/ConnectVoice.
	if err := svc.MoveUser(ctx, "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser failed: %v", err)
	}

	// PRODUCTION ORDER: the grant is already spent by the time voice_join
	// arrives. The client asks for the LiveKit token FIRST and only then sends
	// voice_join (client/src/hooks/ws/voiceEventHandlers.ts), and GenerateToken
	// deletes the one-time grant. The first version of this test skipped that
	// step and so passed against an ordering no real client produces, while the
	// actual flow returned ErrForbidden.
	//
	// The grant is dropped directly rather than by calling GenerateToken: that
	// path needs a LiveKit instance and an encryption key, and pulling all of
	// it in would make this test about token plumbing instead of about
	// authorization. What matters is the post-condition GenerateToken leaves
	// behind — no grant — and that is reproduced exactly.
	concrete, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected *voiceService")
	}
	concrete.mu.Lock()
	delete(concrete.forceMoveGrants, "victim")
	concrete.mu.Unlock()

	// Victim's client now re-syncs voice state for the channel it was just
	// force-moved into. With the grant gone, what has to carry this is
	// MoveUser having written ch2 into the victim's state.
	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch2", false, false); err != nil {
		t.Fatalf("expected force-move placement to allow join into ch2, got error: %v", err)
	}
}

func TestVoiceJoinChannel(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify state
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state for u1")
	}
	if state.ChannelID != "ch1" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch1")
	}
	if state.Username != "alice" {
		t.Errorf("username = %q, want %q", state.Username, "alice")
	}

	// Verify broadcast
	if len(broadcasts) != 1 {
		t.Fatalf("expected 1 broadcast, got %d", len(broadcasts))
	}
	if broadcasts[0].Op != ws.OpVoiceStateUpdate {
		t.Errorf("op = %q, want %q", broadcasts[0].Op, ws.OpVoiceStateUpdate)
	}
}

func TestVoiceJoinChannel_SwitchChannels(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	// Join ch1
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	// Switch to ch2
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false)

	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state")
	}
	if state.ChannelID != "ch2" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch2")
	}

	// Should have: join ch1, leave ch1, join ch2 = 3 broadcasts
	if len(broadcasts) != 3 {
		t.Fatalf("expected 3 broadcasts (join+leave+join), got %d", len(broadcasts))
	}
}

func TestVoiceJoinChannel_SameChannelRejoin(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	// Join ch1
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	broadcasts = nil // reset

	// Rejoin same channel (WS reconnect scenario)
	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	// Should produce zero broadcasts — silent rejoin
	if len(broadcasts) != 0 {
		t.Fatalf("expected 0 broadcasts for same-channel rejoin, got %d", len(broadcasts))
	}

	// State should still exist
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected voice state after rejoin")
	}
	if state.ChannelID != "ch1" {
		t.Errorf("channelID = %q, want %q", state.ChannelID, "ch1")
	}
}

func TestVoiceLeaveChannel(t *testing.T) {
	svc, hub := newTestVoiceService()

	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	broadcasts = nil // reset

	err := svc.LeaveChannel("u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	state := svc.GetUserVoiceState("u1")
	if state != nil {
		t.Error("expected nil state after leave")
	}

	if len(broadcasts) < 1 {
		t.Fatal("expected at least 1 leave broadcast")
	}
}

func TestVoiceLeaveChannel_NotInVoice(t *testing.T) {
	svc, _ := newTestVoiceService()

	// Leave when not in voice should be a no-op
	err := svc.LeaveChannel("u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVoiceUpdateState(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	truev := true
	falsev := false

	// Mute
	_ = svc.UpdateState("u1", &truev, nil, nil)
	state := svc.GetUserVoiceState("u1")
	if !state.IsMuted {
		t.Error("expected muted=true")
	}
	if state.IsDeafened {
		t.Error("expected deafened=false (unchanged)")
	}

	// Deafen
	_ = svc.UpdateState("u1", nil, &truev, nil)
	state = svc.GetUserVoiceState("u1")
	if !state.IsDeafened {
		t.Error("expected deafened=true")
	}

	// Unmute
	_ = svc.UpdateState("u1", &falsev, nil, nil)
	state = svc.GetUserVoiceState("u1")
	if state.IsMuted {
		t.Error("expected muted=false after unmute")
	}

	// Start streaming
	_ = svc.UpdateState("u1", nil, nil, &truev)
	state = svc.GetUserVoiceState("u1")
	if !state.IsStreaming {
		t.Error("expected streaming=true")
	}
}

func TestVoiceUpdateState_NotInVoice(t *testing.T) {
	svc, _ := newTestVoiceService()

	truev := true
	err := svc.UpdateState("u1", &truev, nil, nil)
	if err != nil {
		t.Fatalf("update state for non-voice user should be no-op, got: %v", err)
	}
}

func TestVoiceGetChannelParticipants(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch1", false, false)
	_ = svc.JoinChannel("u3", "charlie", "Charlie", "", "ch2", false, false)

	ch1Participants := svc.GetChannelParticipants("ch1")
	if len(ch1Participants) != 2 {
		t.Errorf("ch1 participants = %d, want 2", len(ch1Participants))
	}

	ch2Participants := svc.GetChannelParticipants("ch2")
	if len(ch2Participants) != 1 {
		t.Errorf("ch2 participants = %d, want 1", len(ch2Participants))
	}

	emptyParticipants := svc.GetChannelParticipants("ch99")
	if len(emptyParticipants) != 0 {
		t.Errorf("empty channel participants = %d, want 0", len(emptyParticipants))
	}
}

func TestVoiceGetAllVoiceStates(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch2", false, false)

	all := svc.GetAllVoiceStates()
	if len(all) != 2 {
		t.Errorf("all states = %d, want 2", len(all))
	}
}

func TestVoiceDisconnectUser(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	svc.DisconnectUser("u1")

	state := svc.GetUserVoiceState("u1")
	if state != nil {
		t.Error("expected nil state after disconnect")
	}
}

func TestVoiceGetStreamCount(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("u2", "bob", "Bob", "", "ch1", false, false)

	if svc.GetStreamCount("ch1") != 0 {
		t.Error("expected 0 streams initially")
	}

	truev := true
	_ = svc.UpdateState("u1", nil, nil, &truev)

	if svc.GetStreamCount("ch1") != 1 {
		t.Errorf("stream count = %d, want 1", svc.GetStreamCount("ch1"))
	}

	_ = svc.UpdateState("u2", nil, nil, &truev)

	if svc.GetStreamCount("ch1") != 2 {
		t.Errorf("stream count = %d, want 2", svc.GetStreamCount("ch1"))
	}
}

func TestVoiceGetUserVoiceChannelID(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	// Not in voice
	if svc.GetUserVoiceChannelID("u1") != "" {
		t.Error("expected empty channel ID for non-voice user")
	}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	if svc.GetUserVoiceChannelID("u1") != "ch1" {
		t.Errorf("channel ID = %q, want %q", svc.GetUserVoiceChannelID("u1"), "ch1")
	}
}

func TestVoiceScreenShareViewerTracking(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	_ = svc.JoinChannel("viewer1", "bob", "Bob", "", "ch1", false, false)

	// Start streaming
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	// Watch
	svc.WatchScreenShare("viewer1", "streamer", true)
	if svc.GetScreenShareViewerCount("streamer") != 1 {
		t.Errorf("viewer count = %d, want 1", svc.GetScreenShareViewerCount("streamer"))
	}

	// Stop watching
	svc.WatchScreenShare("viewer1", "streamer", false)
	if svc.GetScreenShareViewerCount("streamer") != 0 {
		t.Errorf("viewer count = %d, want 0", svc.GetScreenShareViewerCount("streamer"))
	}
}

func TestVoiceCleanupViewersForStreamer(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	svc.WatchScreenShare("v1", "streamer", true)
	svc.WatchScreenShare("v2", "streamer", true)

	if svc.GetScreenShareViewerCount("streamer") != 2 {
		t.Fatalf("expected 2 viewers, got %d", svc.GetScreenShareViewerCount("streamer"))
	}

	svc.CleanupViewersForStreamer("streamer")

	if svc.GetScreenShareViewerCount("streamer") != 0 {
		t.Errorf("expected 0 viewers after cleanup, got %d", svc.GetScreenShareViewerCount("streamer"))
	}
}

// ─── Timeout gates (A3/A6): voice join + token issuance ───

func TestGenerateToken_TimedOutRejected(t *testing.T) {
	svc, _ := newTestVoiceServiceWithTimeoutChecker(&testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, serverID, userID string) (bool, error) {
			if serverID != "srv1" || userID != "u1" {
				t.Errorf("IsActive called with unexpected args: %s %s", serverID, userID)
			}
			return true, nil
		},
	})

	// mockLiveKitGetter (wired by newTestVoiceService) always errors — if the
	// timeout gate didn't fire before the LiveKit lookup, GenerateToken would
	// return that unrelated lookup error instead of ErrForbidden.
	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
	if resp != nil {
		t.Error("expected nil token response for timed-out user")
	}
}

func TestGenerateToken_TimeoutCheckerError_FailsClosed(t *testing.T) {
	checkerErr := fmt.Errorf("timeout store unavailable")
	svc, _ := newTestVoiceServiceWithTimeoutChecker(&testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
			return false, checkerErr
		},
	})

	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err == nil {
		t.Fatal("expected error when the timeout checker itself fails (fail-closed), got nil")
	}
	if !errors.Is(err, checkerErr) {
		t.Errorf("expected wrapped checker error, got %v", err)
	}
	if resp != nil {
		t.Error("expected nil token response when the timeout check errors")
	}
}

func TestGenerateScreenShareToken_TimedOutRejected(t *testing.T) {
	svc, _ := newTestVoiceServiceWithTimeoutChecker(&testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
			return true, nil
		},
	})

	resp, err := svc.GenerateScreenShareToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
	if resp != nil {
		t.Error("expected nil token response for timed-out user")
	}
}

func TestVoiceJoinChannel_TimedOutRejected(t *testing.T) {
	svc, hub := newTestVoiceServiceWithTimeoutChecker(&testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
			return true, nil
		},
	})
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden, got %v", err)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 0 {
		t.Errorf("expected 0 participants after rejected join, got %d", len(participants))
	}
	if len(broadcasts) != 0 {
		t.Errorf("expected 0 broadcasts after rejected join, got %d", len(broadcasts))
	}
}

func TestVoiceJoinChannel_NilTimeoutChecker_Allows(t *testing.T) {
	// newTestVoiceService passes a nil timeoutChecker to NewVoiceService —
	// svc.timeoutChecker stays nil, which must not block joins. Production
	// (main.go/init_services.go) always passes repos.MemberTimeout; this
	// pins the defense-in-depth nil-guard kept in authorizeJoin for test
	// harnesses and any bootstrap path that doesn't wire a checker.
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if err != nil {
		t.Fatalf("unexpected error with nil timeoutChecker: %v", err)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 1 {
		t.Errorf("expected 1 participant, got %d", len(participants))
	}
}

// TestVoiceJoinChannel_TimedOut_RejectedEvenWhenAlreadyInChannel pins that the
// timeout gate in authorizeJoin runs on EVERY JoinChannel call, including the
// same-channel "silent reconnect" path — not just first-time joins. Without
// this, a user timed out mid-session could keep refreshing their WS
// connection and silently stay in voice via the reconnect fast path.
func TestVoiceJoinChannel_TimedOut_RejectedEvenWhenAlreadyInChannel(t *testing.T) {
	var active bool
	svc, hub := newTestVoiceServiceWithTimeoutChecker(&testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
			return active, nil
		},
	})
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	// First join succeeds — not timed out yet.
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	if state := svc.GetUserVoiceState("u1"); state == nil || state.ChannelID != "ch1" {
		t.Fatal("expected u1 to be in ch1 after initial join")
	}

	// Timeout kicks in; same-channel rejoin (e.g. WS reconnect) must now be rejected.
	active = true
	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected pkg.ErrForbidden on rejoin while timed out, got %v", err)
	}
}

func TestVoiceState_ServerMuteDeafen(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)

	state := svc.GetUserVoiceState("u1")
	if state.IsServerMuted || state.IsServerDeafened {
		t.Error("expected no server mute/deafen initially")
	}

	// Simulate server mute via admin (through direct state)
	// AdminUpdateState needs permission resolver, so test the state value after join
	voiceStates := svc.GetAllVoiceStates()
	found := false
	for _, vs := range voiceStates {
		if vs.UserID == "u1" {
			found = true
			if vs.ChannelID != "ch1" {
				t.Errorf("channelID = %q, want ch1", vs.ChannelID)
			}
		}
	}
	if !found {
		t.Error("u1 not found in voice states")
	}
}
