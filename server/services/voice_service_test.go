package services

import (
	"context"
	"errors"
	"fmt"
	"net"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
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

// ─── A-37: screen-share close-out on MoveUser / cross-channel JoinChannel ───
//
// LeaveChannel's screen-share close-out (viewer-set cleanup + leave
// broadcast) also needs to run for a channel a user is leaving via MoveUser
// or a self-initiated cross-channel JoinChannel — not just an explicit
// leave/disconnect. These tests pin the three externally observable effects
// the task calls for: viewer cleanup, the leave broadcast, and IsStreaming
// resetting to false (see the doc comments on MoveUser and JoinChannel's
// state construction for why a stream never carries across a channel
// change).

// findScreenShareLeaveBroadcast looks for a screen-share "leave" broadcast
// for (streamerUserID, channelID, viewerCount 0) among captured events.
func findScreenShareLeaveBroadcast(t *testing.T, broadcasts []ws.Event, streamerUserID, channelID string) bool {
	t.Helper()
	for _, ev := range broadcasts {
		if ev.Op != ws.OpScreenShareViewerUpdate {
			continue
		}
		data, ok := ev.Data.(ws.ScreenShareViewerUpdateData)
		if !ok {
			t.Fatalf("OpScreenShareViewerUpdate broadcast had unexpected Data type %T", ev.Data)
		}
		if data.StreamerUserID == streamerUserID && data.ChannelID == channelID &&
			data.Action == "leave" && data.ViewerCount == 0 {
			return true
		}
	}
	return false
}

// TestMoveUser_ClosesOutScreenShare pins that moving a streaming user (a)
// clears their viewer set, (b) broadcasts a screen-share leave for the
// SOURCE channel, and (c) resets IsStreaming to false on the moved state.
func TestMoveUser_ClosesOutScreenShare(t *testing.T) {
	svc, hub := newTestVoiceService()
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	truev := true
	if err := svc.UpdateState("streamer", nil, nil, &truev); err != nil {
		t.Fatalf("UpdateState(streaming): %v", err)
	}
	// N-19: WatchScreenShare only admits a viewer who already shares the
	// streamer's channel, so the viewer has to join voice first.
	if err := svc.JoinChannel("viewer1", "viewer1", "Viewer1", "", "ch1", false, false); err != nil {
		t.Fatalf("viewer join failed: %v", err)
	}
	svc.WatchScreenShare("viewer1", "streamer", true)
	if got := svc.GetScreenShareViewerCount("streamer"); got != 1 {
		t.Fatalf("setup: expected 1 viewer before the move, got %d", got)
	}

	broadcasts = nil // only care about what MoveUser itself emits
	if err := svc.MoveUser(context.Background(), "admin", "streamer", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}

	// (a) viewer cleanup
	if got := svc.GetScreenShareViewerCount("streamer"); got != 0 {
		t.Errorf("expected 0 viewers after move (screen share closed out), got %d", got)
	}

	// (b) screen-share leave broadcast, for the SOURCE channel
	if !findScreenShareLeaveBroadcast(t, broadcasts, "streamer", "ch1") {
		t.Errorf("expected a screen-share leave broadcast for streamer/ch1, got %+v", broadcasts)
	}

	// (c) IsStreaming false after the move
	state := svc.GetUserVoiceState("streamer")
	if state == nil {
		t.Fatal("expected streamer to still have a voice state after the move")
	}
	if state.IsStreaming {
		t.Error("expected IsStreaming=false after MoveUser — a screen share does not follow a move")
	}
	if state.ChannelID != "ch2" {
		t.Errorf("expected streamer to be in ch2 after move, got %q", state.ChannelID)
	}
}

// TestJoinChannel_CrossChannelSwitch_ClosesOutScreenShare mirrors
// TestMoveUser_ClosesOutScreenShare for a self-initiated channel switch
// (JoinChannel called again with a different channelID while already in
// voice).
func TestJoinChannel_CrossChannelSwitch_ClosesOutScreenShare(t *testing.T) {
	svc, hub := newTestVoiceService()
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	truev := true
	if err := svc.UpdateState("streamer", nil, nil, &truev); err != nil {
		t.Fatalf("UpdateState(streaming): %v", err)
	}
	// N-19: WatchScreenShare only admits a viewer who already shares the
	// streamer's channel, so the viewer has to join voice first.
	if err := svc.JoinChannel("viewer1", "viewer1", "Viewer1", "", "ch1", false, false); err != nil {
		t.Fatalf("viewer join failed: %v", err)
	}
	svc.WatchScreenShare("viewer1", "streamer", true)
	if got := svc.GetScreenShareViewerCount("streamer"); got != 1 {
		t.Fatalf("setup: expected 1 viewer before the switch, got %d", got)
	}

	broadcasts = nil // only care about what the cross-channel JoinChannel itself emits
	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch2", false, false); err != nil {
		t.Fatalf("cross-channel join failed: %v", err)
	}

	// (a) viewer cleanup
	if got := svc.GetScreenShareViewerCount("streamer"); got != 0 {
		t.Errorf("expected 0 viewers after switching channels (screen share closed out), got %d", got)
	}

	// (b) screen-share leave broadcast, for the OLD channel
	if !findScreenShareLeaveBroadcast(t, broadcasts, "streamer", "ch1") {
		t.Errorf("expected a screen-share leave broadcast for streamer/ch1, got %+v", broadcasts)
	}

	// (c) IsStreaming false after the switch
	state := svc.GetUserVoiceState("streamer")
	if state == nil {
		t.Fatal("expected streamer to still have a voice state after the channel switch")
	}
	if state.IsStreaming {
		t.Error("expected IsStreaming=false after switching channels — a screen share does not follow the user")
	}
	if state.ChannelID != "ch2" {
		t.Errorf("expected streamer to be in ch2 after the switch, got %q", state.ChannelID)
	}
}

// TestJoinChannel_CrossChannelSwitch_PreservesServerMuteDeafen pins the
// A-37 follow-up behavior decision: a server-mute/deafen moderation
// sanction (AdminUpdateState) survives the target's own voluntary channel
// switch — Discord parity, and the deliberate asymmetric counterpart to
// IsStreaming resetting on the same switch (see the fresh-state
// construction comment in JoinChannel). Both the new state and the
// join(new channel) broadcast payload must carry the sanction forward.
func TestJoinChannel_CrossChannelSwitch_PreservesServerMuteDeafen(t *testing.T) {
	svc, hub := newTestVoiceService()
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	truev := true
	if err := svc.AdminUpdateState(context.Background(), "admin", "u1", &truev, &truev); err != nil {
		t.Fatalf("AdminUpdateState(server-mute+deafen): %v", err)
	}
	if state := svc.GetUserVoiceState("u1"); state == nil || !state.IsServerMuted || !state.IsServerDeafened {
		t.Fatalf("setup: expected u1 server-muted+deafened before the switch, got %+v", state)
	}

	broadcasts = nil // only care about what the cross-channel JoinChannel itself emits
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("cross-channel join failed: %v", err)
	}

	// New state: both flags survive the switch.
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected u1 to still have a voice state after the channel switch")
	}
	if !state.IsServerMuted || !state.IsServerDeafened {
		t.Errorf("expected IsServerMuted/IsServerDeafened to survive the switch, got IsServerMuted=%v IsServerDeafened=%v",
			state.IsServerMuted, state.IsServerDeafened)
	}
	if state.ChannelID != "ch2" {
		t.Errorf("expected u1 to be in ch2 after the switch, got %q", state.ChannelID)
	}

	// join(ch2) broadcast payload also carries both flags true.
	found := false
	for _, ev := range broadcasts {
		if ev.Op != ws.OpVoiceStateUpdate {
			continue
		}
		data, ok := ev.Data.(ws.VoiceStateUpdateBroadcast)
		if !ok {
			t.Fatalf("OpVoiceStateUpdate broadcast had unexpected Data type %T", ev.Data)
		}
		if data.Action != "join" || data.ChannelID != "ch2" {
			continue
		}
		if !data.IsServerMuted || !data.IsServerDeafened {
			t.Errorf("join(ch2) broadcast has IsServerMuted=%v IsServerDeafened=%v, want both true",
				data.IsServerMuted, data.IsServerDeafened)
		}
		found = true
	}
	if !found {
		t.Errorf("expected a join(ch2) OpVoiceStateUpdate broadcast, got %+v", broadcasts)
	}
}

// TestJoinChannel_CrossServerSwitch_DropsServerMuteDeafen pins the A-38
// review MEDIUM fix: a server-mute/deafen sanction must NOT follow a user
// across a cross-SERVER channel switch — only a same-server switch carries
// it (see TestJoinChannel_CrossChannelSwitch_PreservesServerMuteDeafen
// above). Without the oldServerID == serverID gate, a sanction server A's
// moderator applied would silently apply in server B's voice channel with
// zero action from any of server B's moderators. The shared
// newTestVoiceServiceWithChannelRepo happy-path channel repo always
// returns "srv1", so this test injects its own ChannelGetter that maps
// ch2 to a different server ("srv2").
func TestJoinChannel_CrossServerSwitch_DropsServerMuteDeafen(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			serverID := "srv1"
			if id == "ch2" {
				serverID = "srv2"
			}
			return &models.Channel{ID: id, ServerID: serverID, Type: models.ChannelTypeVoice}, nil
		},
	}
	svc, hub := newTestVoiceServiceWithChannelRepo(channelRepo)
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	truev := true
	if err := svc.AdminUpdateState(context.Background(), "admin", "u1", &truev, &truev); err != nil {
		t.Fatalf("AdminUpdateState(server-mute+deafen): %v", err)
	}
	if state := svc.GetUserVoiceState("u1"); state == nil || !state.IsServerMuted || !state.IsServerDeafened {
		t.Fatalf("setup: expected u1 server-muted+deafened before the switch, got %+v", state)
	}

	broadcasts = nil // only care about what the cross-server JoinChannel itself emits
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("cross-server join failed: %v", err)
	}

	// New state: both flags dropped (cross-server, not same-server).
	state := svc.GetUserVoiceState("u1")
	if state == nil {
		t.Fatal("expected u1 to still have a voice state after the switch")
	}
	if state.IsServerMuted || state.IsServerDeafened {
		t.Errorf("expected IsServerMuted/IsServerDeafened to be dropped on a cross-server switch, got IsServerMuted=%v IsServerDeafened=%v",
			state.IsServerMuted, state.IsServerDeafened)
	}
	if state.ChannelID != "ch2" || state.ServerID != "srv2" {
		t.Errorf("expected u1 to be in ch2/srv2 after the switch, got channel=%q server=%q", state.ChannelID, state.ServerID)
	}

	// join(ch2) broadcast payload also reflects both flags false.
	found := false
	for _, ev := range broadcasts {
		if ev.Op != ws.OpVoiceStateUpdate {
			continue
		}
		data, ok := ev.Data.(ws.VoiceStateUpdateBroadcast)
		if !ok {
			t.Fatalf("OpVoiceStateUpdate broadcast had unexpected Data type %T", ev.Data)
		}
		if data.Action != "join" || data.ChannelID != "ch2" {
			continue
		}
		if data.IsServerMuted || data.IsServerDeafened {
			t.Errorf("join(ch2) broadcast has IsServerMuted=%v IsServerDeafened=%v, want both false",
				data.IsServerMuted, data.IsServerDeafened)
		}
		found = true
	}
	if !found {
		t.Errorf("expected a join(ch2) OpVoiceStateUpdate broadcast, got %+v", broadcasts)
	}
}

// TestAdminDisconnectUser_ClosesOutScreenShare mirrors
// TestMoveUser_ClosesOutScreenShare / TestJoinChannel_CrossChannelSwitch_ClosesOutScreenShare
// for force-disconnect. AdminDisconnectUser removes the target's voice
// state entirely (not just resetting IsStreaming, since there's no
// surviving state to reset it on) — so the third pin here is "the state is
// gone" rather than "IsStreaming is false".
func TestAdminDisconnectUser_ClosesOutScreenShare(t *testing.T) {
	svc, hub := newTestVoiceService()
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	truev := true
	if err := svc.UpdateState("streamer", nil, nil, &truev); err != nil {
		t.Fatalf("UpdateState(streaming): %v", err)
	}
	// N-19: WatchScreenShare only admits a viewer who already shares the
	// streamer's channel, so the viewer has to join voice first.
	if err := svc.JoinChannel("viewer1", "viewer1", "Viewer1", "", "ch1", false, false); err != nil {
		t.Fatalf("viewer join failed: %v", err)
	}
	svc.WatchScreenShare("viewer1", "streamer", true)
	if got := svc.GetScreenShareViewerCount("streamer"); got != 1 {
		t.Fatalf("setup: expected 1 viewer before the disconnect, got %d", got)
	}

	broadcasts = nil // only care about what AdminDisconnectUser itself emits
	if err := svc.AdminDisconnectUser(context.Background(), "admin", "streamer"); err != nil {
		t.Fatalf("AdminDisconnectUser: %v", err)
	}

	// (a) viewer cleanup
	if got := svc.GetScreenShareViewerCount("streamer"); got != 0 {
		t.Errorf("expected 0 viewers after force-disconnect (screen share closed out), got %d", got)
	}

	// (b) screen-share leave broadcast, for the channel the target was disconnected from
	if !findScreenShareLeaveBroadcast(t, broadcasts, "streamer", "ch1") {
		t.Errorf("expected a screen-share leave broadcast for streamer/ch1, got %+v", broadcasts)
	}

	// (c) state gone entirely (AdminDisconnectUser deletes it, unlike
	// MoveUser/cross-switch which keep a state with IsStreaming reset)
	if state := svc.GetUserVoiceState("streamer"); state != nil {
		t.Errorf("expected no voice state for streamer after force-disconnect, got %+v", state)
	}
}

// ─── A-38 review regression fix: music bot stop on cross-channel switch ───
//
// The client no longer sends voice_leave on a channel switch (A-38's
// root-cause fix moved that responsibility to JoinChannel's cross-channel
// branch), so LeaveChannel's "kick the music bot if the vacated channel
// emptied" logic — which only ever ran from LeaveChannel — silently stopped
// firing for switches too. These tests are the switch-side mirror of that
// LeaveChannel behavior; see the oldChannelEmpty comments in JoinChannel
// itself for why this is a hand-synced copy, not a shared helper (yet).

// mockMusicBotHook is a function-field MusicBotChannelHook mock, matching
// the mockBanChecker/testutil.MockMemberTimeoutRepo convention used
// elsewhere in this file.
type mockMusicBotHook struct {
	StopAllForChannelFn func(channelID string)
}

func (m *mockMusicBotHook) StopAllForChannel(channelID string) {
	if m.StopAllForChannelFn != nil {
		m.StopAllForChannelFn(channelID)
	}
}

// TestJoinChannel_CrossChannelSwitch_StopsMusicBotWhenOldChannelEmpties pins
// the fix: the sole occupant of ch1 switching to ch2 must stop any music
// bot left playing in the now-empty ch1.
func TestJoinChannel_CrossChannelSwitch_StopsMusicBotWhenOldChannelEmpties(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) {
			stopped <- channelID
		},
	})

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("cross-channel join failed: %v", err)
	}

	select {
	case got := <-stopped:
		if got != "ch1" {
			t.Errorf("StopAllForChannel called with %q, want ch1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected StopAllForChannel(ch1) to be dispatched, timed out waiting")
	}

	// No second, unexpected call.
	select {
	case extra := <-stopped:
		t.Errorf("unexpected extra StopAllForChannel call for %q", extra)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestJoinChannel_CrossChannelSwitch_DoesNotStopMusicBotWhenOldChannelStillOccupied
// pins the negative case: ch1 isn't empty after the switch (u2 remains), so
// no stop is dispatched — mirrors LeaveChannel's own channelEmpty guard.
func TestJoinChannel_CrossChannelSwitch_DoesNotStopMusicBotWhenOldChannelStillOccupied(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) {
			stopped <- channelID
		},
	})

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("u1 initial join failed: %v", err)
	}
	if err := svc.JoinChannel("u2", "bob", "Bob", "", "ch1", false, false); err != nil {
		t.Fatalf("u2 initial join failed: %v", err)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("u1 cross-channel join failed: %v", err)
	}

	select {
	case got := <-stopped:
		t.Errorf("expected no StopAllForChannel call (ch1 still occupied by u2), got %q", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// ─── Systematic "user is vacating this channel" side-effect audit (F1-F8) ───
//
// A coordinator-requested audit found LeaveChannel's full side-effect list
// (leave broadcast, screen-share close-out, channel-empty music-bot stop,
// quota credit, LiveKit eviction) wasn't consistently mirrored by every
// other path that also ends a user's presence in a channel: JoinChannel's
// cross-channel branch (already fixed for two of these — A-38 — but not the
// F1 stale-state case below), AdminDisconnectUser, MoveUser, and the orphan
// sweep. These tests pin the eight fixes from that audit.

// TestJoinChannel_EarlyAuthFailure_CleansUpStaleState pins F1 (HIGH, our
// own A-38 regression): since the client no longer sends voice_leave on a
// switch, a legitimate authorizeJoin rejection between token issuance and
// voice_join (e.g. a moderator applied a timeout in that window) must not
// leave the user's server-side state stuck in the OLD channel — that
// ghost entry would never empty the channel (no music-bot-stop, no
// passphrase cleanup) and would be counted by remainingChannelMembers on a
// later kick/move in that channel, pushing the rotated E2EE passphrase to
// it (voice_e2ee.go) — the exact leak class N-01 exists to prevent.
func TestJoinChannel_EarlyAuthFailure_CleansUpStaleState(t *testing.T) {
	svc, hub := newAuthVoiceService(true, func(_ context.Context, _, channelID string) (models.Permission, error) {
		if channelID == "ch2" {
			return 0, nil // no ConnectVoice in ch2 — e.g. a moderator just timed the user out
		}
		return models.PermAll, nil
	})
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	if state := svc.GetUserVoiceState("u1"); state == nil || state.ChannelID != "ch1" {
		t.Fatalf("setup: expected u1 in ch1, got %+v", state)
	}

	broadcasts = nil // only care about what the failed join itself emits
	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden from the failed join, got %v", err)
	}

	// No ghost state left behind.
	if state := svc.GetUserVoiceState("u1"); state != nil {
		t.Errorf("expected no voice state for u1 after the failed join, got %+v (F1 regression: ghost state)", state)
	}
	if participants := svc.GetChannelParticipants("ch1"); len(participants) != 0 {
		t.Errorf("expected 0 participants in ch1 after cleanup, got %d — a ghost here would poison remainingChannelMembers", len(participants))
	}

	// LeaveChannel's own leave broadcast fired for ch1 as part of the cleanup.
	if !findVoiceStateLeaveBroadcast(t, broadcasts, "ch1") {
		t.Errorf("expected a leave broadcast for ch1 from the cleanup, got %+v", broadcasts)
	}
}

// TestJoinChannel_EarlyChannelLookupFailure_CleansUpStaleState pins F1's
// other early-return path: a channelGetter.GetByID failure for the NEW
// channel (e.g. it was deleted between the client requesting a token and
// sending voice_join) must equally not strand the user in the OLD channel.
func TestJoinChannel_EarlyChannelLookupFailure_CleansUpStaleState(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			if id == "ch2" {
				return nil, pkg.ErrNotFound
			}
			return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
		},
	}
	svc, hub := newTestVoiceServiceWithChannelRepo(channelRepo)
	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	broadcasts = nil
	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false)
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("expected ErrNotFound from the failed join, got %v", err)
	}

	if state := svc.GetUserVoiceState("u1"); state != nil {
		t.Errorf("expected no voice state for u1 after the failed join, got %+v (F1 regression: ghost state)", state)
	}
	if !findVoiceStateLeaveBroadcast(t, broadcasts, "ch1") {
		t.Errorf("expected a leave broadcast for ch1 from the cleanup, got %+v", broadcasts)
	}
}

// findVoiceStateLeaveBroadcast looks for an OpVoiceStateUpdate "leave" for
// channelID among captured events.
func findVoiceStateLeaveBroadcast(t *testing.T, broadcasts []ws.Event, channelID string) bool {
	t.Helper()
	for _, ev := range broadcasts {
		if ev.Op != ws.OpVoiceStateUpdate {
			continue
		}
		data, ok := ev.Data.(ws.VoiceStateUpdateBroadcast)
		if !ok {
			t.Fatalf("OpVoiceStateUpdate broadcast had unexpected Data type %T", ev.Data)
		}
		if data.Action == "leave" && data.ChannelID == channelID {
			return true
		}
	}
	return false
}

// TestJoinChannel_SameChannelRejoin_TransientAuthError_PreservesLiveSession
// pins the F1 review MEDIUM fix: the client resends voice_join for the SAME
// channel on every WS reconnect while its LiveKit connection stays up
// (client/src/hooks/ws/systemEventHandlers.ts), and that hits
// authorizeJoin's IsMember/IsActive/ResolveChannelPermissions calls BEFORE
// authorizeJoin's own same-channel fast path (alreadyInChannel) ever runs.
// A TRANSIENT (non-sentinel) failure from one of those must not tear down
// an actively-connected session the way a genuine authoritative rejection
// correctly does — this pins the negative case: state untouched, no leave
// broadcast, no eviction dispatch.
func TestJoinChannel_SameChannelRejoin_TransientAuthError_PreservesLiveSession(t *testing.T) {
	transientErr := fmt.Errorf("membership store unavailable")
	memberCalls := 0

	lkCalls := make(chan string, 8)
	lkGetter := &mockConfigurableLiveKitGetter{
		GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
			lkCalls <- serverID
			return nil, fmt.Errorf("no livekit instance in test")
		},
	}

	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		lkGetter,
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) {
				memberCalls++
				if memberCalls == 1 {
					return true, nil // initial join succeeds
				}
				return false, transientErr // rejoin: a transient DB hiccup, NOT a sentinel
			},
		},
		nil, // encryptionKey
		nil, // timeoutChecker
		nil, // banChecker
	)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	// The successful initial join makes its own (expected) quota-tracking
	// GetByServerID call — drain it before checking for an unexpected one
	// from the failed rejoin below.
	drainCalls(lkCalls)

	var broadcasts []ws.Event
	hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		broadcasts = append(broadcasts, event)
	}

	err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false)
	if err == nil {
		t.Fatal("expected an error from the transient membership-check failure")
	}
	if errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("expected a plain transient error (not pkg.ErrForbidden), got %v", err)
	}

	// State untouched — LeaveChannel must not have run.
	state := svc.GetUserVoiceState("u1")
	if state == nil || state.ChannelID != "ch1" {
		t.Fatalf("expected u1's state to remain in ch1 untouched, got %+v", state)
	}

	// No leave broadcast from the (non-existent) cleanup.
	if findVoiceStateLeaveBroadcast(t, broadcasts, "ch1") {
		t.Errorf("expected no leave broadcast from a transient same-channel rejoin failure, got %+v", broadcasts)
	}

	// No eviction dispatch either — LeaveChannel is the only caller of
	// removeParticipantAndScreenShareFromLiveKit, and that path's own
	// GetByServerID call (inside removeParticipantFromLiveKit) would show
	// up here as an unexpected second lkCalls receive. (Not reusing
	// expectNoEvictionDispatch: its message hardcodes "GetByID", which
	// would be misleading for a GetByServerID-fed channel like this one.)
	select {
	case got := <-lkCalls:
		t.Errorf("expected no LiveKit eviction dispatch (GetByServerID call), got %q", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestAdminDisconnectUser_StopsMusicBotWhenChannelEmpties pins F2 (MEDIUM):
// AdminDisconnectUser never ran LeaveChannel's channelEmpty scan, so a music
// bot left playing after the sole occupant was force-disconnected never
// stopped.
func TestAdminDisconnectUser_StopsMusicBotWhenChannelEmpties(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	if err := svc.AdminDisconnectUser(context.Background(), "admin", "victim"); err != nil {
		t.Fatalf("AdminDisconnectUser: %v", err)
	}

	select {
	case got := <-stopped:
		if got != "ch1" {
			t.Errorf("StopAllForChannel called with %q, want ch1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected StopAllForChannel(ch1) to be dispatched, timed out waiting")
	}
}

// TestAdminDisconnectUser_DoesNotStopMusicBotWhenChannelStillOccupied pins
// F2's negative case: a bystander remains in the channel, so no stop fires.
func TestAdminDisconnectUser_DoesNotStopMusicBotWhenChannelStillOccupied(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("victim initial join failed: %v", err)
	}
	if err := svc.JoinChannel("bystander", "bob", "Bob", "", "ch1", false, false); err != nil {
		t.Fatalf("bystander initial join failed: %v", err)
	}

	if err := svc.AdminDisconnectUser(context.Background(), "admin", "victim"); err != nil {
		t.Fatalf("AdminDisconnectUser: %v", err)
	}

	select {
	case got := <-stopped:
		t.Errorf("expected no StopAllForChannel call (ch1 still occupied by bystander), got %q", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// mockConfigurableLiveKitGetter is a function-field LiveKitInstanceGetter
// mock. Unlike the shared mockLiveKitGetter (which always errors past the
// channel lookup, so VoiceState.LiveKitInstanceID/LiveKitIsCloud never get
// populated in the rest of this file's tests), this lets a test supply a
// real cloud instance so creditUsage's own early-exit guards (!isCloud ||
// instanceID == "") don't swallow the call before it reaches
// IncrementMonthlyUsage — needed to observe F4's fix.
type mockConfigurableLiveKitGetter struct {
	GetByServerIDFn         func(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
	IncrementMonthlyUsageFn func(ctx context.Context, instanceID string, year, month, seconds int) error
}

func (m *mockConfigurableLiveKitGetter) GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	if m.GetByServerIDFn != nil {
		return m.GetByServerIDFn(ctx, serverID)
	}
	return nil, fmt.Errorf("no livekit instance in test")
}
func (m *mockConfigurableLiveKitGetter) GetMonthlyUsage(_ context.Context, _ string, _, _ int) (int64, error) {
	return 0, nil
}
func (m *mockConfigurableLiveKitGetter) IncrementMonthlyUsage(ctx context.Context, instanceID string, year, month, seconds int) error {
	if m.IncrementMonthlyUsageFn != nil {
		return m.IncrementMonthlyUsageFn(ctx, instanceID, year, month, seconds)
	}
	return nil
}
func (m *mockConfigurableLiveKitGetter) GetNextAutoSwitchInstance(_ context.Context, _ string, _, _ int) (*models.LiveKitInstance, error) {
	return nil, nil
}
func (m *mockConfigurableLiveKitGetter) MigrateOneServer(_ context.Context, _, _ string) error {
	return nil
}

// newTestVoiceServiceWithLiveKitGetter is newTestVoiceService with an
// injectable LiveKitInstanceGetter, for tests that need
// VoiceState.LiveKitInstanceID/LiveKitIsCloud actually populated (see
// mockConfigurableLiveKitGetter).
func newTestVoiceServiceWithLiveKitGetter(lkGetter LiveKitInstanceGetter) (VoiceService, *testutil.MockBroadcaster) {
	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		lkGetter,
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
		nil, // timeoutChecker — not under test here
		nil, // banChecker — not under test here
	)
	return svc, hub
}

// TestAdminDisconnectUser_CreditsUsage pins F4 (MEDIUM): AdminDisconnectUser
// never called creditUsage, so a session an admin ended via force-disconnect
// was never attributed to its cloud LiveKit instance's monthly usage bucket.
func TestAdminDisconnectUser_CreditsUsage(t *testing.T) {
	incremented := make(chan string, 4)
	lkGetter := &mockConfigurableLiveKitGetter{
		GetByServerIDFn: func(_ context.Context, _ string) (*models.LiveKitInstance, error) {
			return &models.LiveKitInstance{ID: "lk1", IsPlatformManaged: true}, nil
		},
		IncrementMonthlyUsageFn: func(_ context.Context, instanceID string, _, _, _ int) error {
			incremented <- instanceID
			return nil
		},
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(lkGetter)
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	// creditUsage no-ops for a sub-second session (int(time.Since(...).
	// Seconds()) truncates to 0) — backdate JoinedAt directly (white-box)
	// instead of sleeping in the test, so the elapsed "session" is
	// deterministically long enough regardless of test execution speed.
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box JoinedAt override")
	}
	vs.mu.Lock()
	vs.states["victim"].JoinedAt = time.Now().Add(-time.Hour)
	vs.mu.Unlock()

	if err := svc.AdminDisconnectUser(context.Background(), "admin", "victim"); err != nil {
		t.Fatalf("AdminDisconnectUser: %v", err)
	}

	select {
	case got := <-incremented:
		if got != "lk1" {
			t.Errorf("IncrementMonthlyUsage called with instance %q, want lk1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected creditUsage to reach IncrementMonthlyUsage, timed out waiting")
	}
}

// TestMoveUser_StopsMusicBotWhenSourceChannelEmpties pins F7 (LOW): MoveUser
// never checked whether the SOURCE channel emptied out, so a music bot left
// playing there after the sole occupant was moved elsewhere never stopped.
func TestMoveUser_StopsMusicBotWhenSourceChannelEmpties(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUsersFn = func(_ []string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	if err := svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}

	select {
	case got := <-stopped:
		if got != "ch1" {
			t.Errorf("StopAllForChannel called with %q, want ch1 (source)", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected StopAllForChannel(ch1) to be dispatched, timed out waiting")
	}
}

// TestMoveUser_DoesNotStopMusicBotWhenSourceChannelStillOccupied pins F7's
// negative case: a bystander remains in the source channel, so no stop
// fires.
func TestMoveUser_DoesNotStopMusicBotWhenSourceChannelStillOccupied(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}
	hub.BroadcastToUsersFn = func(_ []string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("victim initial join failed: %v", err)
	}
	if err := svc.JoinChannel("bystander", "bob", "Bob", "", "ch1", false, false); err != nil {
		t.Fatalf("bystander initial join failed: %v", err)
	}

	if err := svc.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}

	select {
	case got := <-stopped:
		t.Errorf("expected no StopAllForChannel call (ch1 still occupied by bystander), got %q", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestMoveUser_RejectsCrossServerMove pins F6 (LOW decision): MoveUser
// rejects a target channel on a different server than the target user's
// current one, rather than silently misattributing quota (see MoveUser's
// own doc comment for the full decision rationale).
func TestMoveUser_RejectsCrossServerMove(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			serverID := "srv1"
			if id == "ch2" {
				serverID = "srv2"
			}
			return &models.Channel{ID: id, ServerID: serverID, Type: models.ChannelTypeVoice}, nil
		},
	}
	svc, hub := newTestVoiceServiceWithChannelRepo(channelRepo)
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	err := svc.MoveUser(context.Background(), "admin", "victim", "ch2")
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest for a cross-server move, got %v", err)
	}

	// State untouched by the rejected move.
	state := svc.GetUserVoiceState("victim")
	if state == nil || state.ChannelID != "ch1" || state.ServerID != "srv1" {
		t.Errorf("expected victim to remain in ch1/srv1 after the rejected move, got %+v", state)
	}
}

// TestOrphanSweep_ClosesOutScreenShareViewer pins F5 (MEDIUM): the orphan
// sweep never ran closeOutScreenShareLocked, so a viewer whose WS
// connection dropped (no beforeunload/pagehide voice_leave — this sweep is
// the only cleanup path a closed tab actually takes) was never removed
// from the streamer's viewer set. Isolates the viewer-side cleanup only:
// the streamer's own offline tracking is left fresh (grace timer just
// started) so only the viewer is evicted in this single sweep pass.
func TestOrphanSweep_ClosesOutScreenShareViewer(t *testing.T) {
	svc, hub := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
		},
	})
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box orphan-sweep access")
	}

	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch1", false, false); err != nil {
		t.Fatalf("streamer join failed: %v", err)
	}
	truev := true
	if err := svc.UpdateState("streamer", nil, nil, &truev); err != nil {
		t.Fatalf("UpdateState(streaming): %v", err)
	}
	if err := svc.JoinChannel("viewer", "viewerName", "Viewer", "", "ch1", false, false); err != nil {
		t.Fatalf("viewer join failed: %v", err)
	}
	svc.WatchScreenShare("viewer", "streamer", true)
	if got := svc.GetScreenShareViewerCount("streamer"); got != 1 {
		t.Fatalf("setup: expected 1 viewer before the sweep, got %d", got)
	}

	// Simulate the viewer's WS connection having already been offline past
	// the grace period (the streamer stays "online" from the sweep's
	// perspective for this one pass, since its own offlineSince entry is
	// freshly started by Phase 1, not stale).
	vs.mu.Lock()
	vs.offlineSince["viewer"] = time.Now().Add(-orphanGracePeriod - time.Second)
	vs.mu.Unlock()

	vs.sweepOrphanStates()

	if got := svc.GetScreenShareViewerCount("streamer"); got != 0 {
		t.Errorf("expected 0 viewers after the orphan sweep removed the offline watcher, got %d", got)
	}
	// Streamer's own session must be untouched by this pass.
	if state := svc.GetUserVoiceState("streamer"); state == nil || state.ChannelID != "ch1" {
		t.Errorf("expected streamer to remain in ch1 (not swept this pass), got %+v", state)
	}
}

// TestOrphanSweep_StopsMusicBotWhenChannelEmpties pins F3 (MEDIUM,
// highest-impact of this audit in practice): a closed browser tab sends no
// beforeunload/pagehide voice_leave and always falls through to this 35s
// sweep to empty its channel, so the orphan sweep's missing
// channelEmpty/music-bot-stop was the most common way a music bot was left
// orphaned.
func TestOrphanSweep_StopsMusicBotWhenChannelEmpties(t *testing.T) {
	svc, hub := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
		},
	})
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box orphan-sweep access")
	}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	vs.mu.Lock()
	vs.offlineSince["victim"] = time.Now().Add(-orphanGracePeriod - time.Second)
	vs.mu.Unlock()

	vs.sweepOrphanStates()

	select {
	case got := <-stopped:
		if got != "ch1" {
			t.Errorf("StopAllForChannel called with %q, want ch1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected StopAllForChannel(ch1) to be dispatched, timed out waiting")
	}
}

// TestOrphanSweep_DoesNotStopMusicBotWhenChannelStillOccupied pins F3's
// negative case: a still-online bystander remains in the channel, so no
// stop fires when the offline user is swept.
func TestOrphanSweep_DoesNotStopMusicBotWhenChannelStillOccupied(t *testing.T) {
	onlineChecker := &testutil.MockBroadcastAndOnline{
		GetOnlineUserIDsFn: func() []string { return []string{"bystander"} },
	}
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
		onlineChecker,
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) { return true, nil },
		},
		nil, // encryptionKey
		nil, // timeoutChecker
		nil, // banChecker
	)
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	stopped := make(chan string, 4)
	svc.SetMusicBotHook(&mockMusicBotHook{
		StopAllForChannelFn: func(channelID string) { stopped <- channelID },
	})

	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box orphan-sweep access")
	}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("victim initial join failed: %v", err)
	}
	if err := svc.JoinChannel("bystander", "bob", "Bob", "", "ch1", false, false); err != nil {
		t.Fatalf("bystander initial join failed: %v", err)
	}

	// Only victim is offline long enough to be swept; bystander is in
	// onlineChecker's set so Phase 1 never starts an offline timer for them.
	vs.mu.Lock()
	vs.offlineSince["victim"] = time.Now().Add(-orphanGracePeriod - time.Second)
	vs.mu.Unlock()

	vs.sweepOrphanStates()

	if state := svc.GetUserVoiceState("victim"); state != nil {
		t.Fatalf("setup: expected victim to have been swept, got %+v", state)
	}

	select {
	case got := <-stopped:
		t.Errorf("expected no StopAllForChannel call (ch1 still occupied by bystander), got %q", got)
	case <-time.After(150 * time.Millisecond):
	}
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

	// N-19: WatchScreenShare now requires the viewer to be in the streamer's
	// channel, so v1/v2 must join ch1 before they can be admitted as viewers.
	_ = svc.JoinChannel("v1", "v1", "V1", "", "ch1", false, false)
	_ = svc.JoinChannel("v2", "v2", "V2", "", "ch1", false, false)

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

// TestWatchScreenShare_RejectsViewerOutsideStreamerChannel pins the N-19
// fix: a viewer sitting in a different voice channel from the streamer must
// not be admitted, even though the streamer is legitimately streaming.
func TestWatchScreenShare_RejectsViewerOutsideStreamerChannel(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	_ = svc.JoinChannel("viewer", "bob", "Bob", "", "ch2", false, false)

	svc.WatchScreenShare("viewer", "streamer", true)

	if count := svc.GetScreenShareViewerCount("streamer"); count != 0 {
		t.Errorf("viewer count = %d, want 0 (viewer is in a different channel)", count)
	}
}

// TestWatchScreenShare_RejectsViewerNotInVoice pins the N-19 fix for a
// viewer that never joined any voice channel at all.
func TestWatchScreenShare_RejectsViewerNotInVoice(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	svc.WatchScreenShare("viewer", "streamer", true)

	if count := svc.GetScreenShareViewerCount("streamer"); count != 0 {
		t.Errorf("viewer count = %d, want 0 (viewer never joined voice)", count)
	}
}

// TestWatchScreenShare_AllowsViewerInStreamerChannel is the positive
// counterpart to the two rejection tests above: a legitimate viewer sitting
// in the streamer's own channel must still be counted. Without this, a
// "reject everything" mutation of the N-19 guard would pass the other two
// tests too.
func TestWatchScreenShare_AllowsViewerInStreamerChannel(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToAllFn = func(_ ws.Event) {}

	_ = svc.JoinChannel("streamer", "alice", "Alice", "", "ch1", false, false)
	truev := true
	_ = svc.UpdateState("streamer", nil, nil, &truev)

	_ = svc.JoinChannel("viewer", "bob", "Bob", "", "ch1", false, false)

	svc.WatchScreenShare("viewer", "streamer", true)

	if count := svc.GetScreenShareViewerCount("streamer"); count != 1 {
		t.Errorf("viewer count = %d, want 1 (viewer shares streamer's channel)", count)
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

// ─── LiveKit publish-grant enforcement for server-mute ───
//
// IsServerMuted was previously a client-side-only advisory (useMicSync) —
// GenerateToken's canPublish only ever checked PermSpeak, so a server-muted
// user with a modified/custom client could keep publishing audio. These
// tests pin both halves of the fix: token issuance (GenerateToken folding
// the live mute state into canPublish) and mid-session enforcement
// (AdminUpdateState dispatching a LiveKit re-authorization the moment the
// mute actually flips). The mid-session dispatch tests observe only that
// the LiveKit call was ATTEMPTED (via GetByServerID, the first step of
// applyServerMuteToLiveKit) — matching this file's established testing
// depth for every other LiveKit-touching goroutine (e.g.
// TestEnforceModerationOnJoin_TimedOut_RemovesParticipant's own doc
// comment): the actual UpdateParticipant/GetParticipant/MutePublishedTrack
// wire calls go through a concrete lksdk.RoomServiceClient that isn't
// mockable via this package's DI, so they aren't exercised here. The
// higher-risk PERMISSION-FIELD-PRESERVATION logic (not silently stripping
// CanSubscribe/CanPublishData/etc. when flipping CanPublish) is instead
// covered directly and precisely by the pure buildServerMutePermission
// tests below, which need no LiveKit mocking at all.

const (
	tokenTestAPIKey    = "test-api-key"
	tokenTestAPISecret = "test-api-secret-needs-length"
)

// tokenTestEncryptionKey is a fixed 32-byte AES-256 key so
// crypto.Encrypt/crypto.Decrypt round-trip inside these tests.
var tokenTestEncryptionKey = []byte("0123456789abcdef0123456789abcdef")[:32]

// newTokenTestVoiceService builds a voiceService whose LiveKitInstanceGetter
// returns real, crypto.Encrypt-ed fake credentials — needed so GenerateToken
// reaches actual local JWT signing (crypto.Decrypt requires a genuine
// ciphertext/key pair, unlike the shared always-erroring mockLiveKitGetter).
// GenerateToken itself never touches lksdk.RoomServiceClient — only
// crypto.Decrypt + local JWT signing — so this makes no network call.
func newTokenTestVoiceService(t *testing.T) VoiceService {
	t.Helper()
	encAPIKey, err := crypto.Encrypt(tokenTestAPIKey, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api key: %v", err)
	}
	encAPISecret, err := crypto.Encrypt(tokenTestAPISecret, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api secret: %v", err)
	}

	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockConfigurableLiveKitGetter{
			GetByServerIDFn: func(_ context.Context, _ string) (*models.LiveKitInstance, error) {
				return &models.LiveKitInstance{
					ID: "lk1", URL: "wss://fake.example",
					APIKey: encAPIKey, APISecret: encAPISecret,
					IsPlatformManaged: false,
				}, nil
			},
		},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) { return true, nil },
		},
		tokenTestEncryptionKey,
		nil, // timeoutChecker
		nil, // banChecker
	)
	return svc
}

// decodeVideoGrant parses tokenString (as issued by GenerateToken) and
// returns its verified video grant.
func decodeVideoGrant(t *testing.T, tokenString, apiSecret string) *auth.VideoGrant {
	t.Helper()
	verifier, err := auth.ParseAPIToken(tokenString)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	_, grants, err := verifier.Verify(apiSecret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if grants.Video == nil {
		t.Fatal("expected a video grant in the token")
	}
	return grants.Video
}

// TestGenerateToken_ServerMuted_CanPublishFalse pins the token-issuance
// half of the fix.
func TestGenerateToken_ServerMuted_CanPublishFalse(t *testing.T) {
	svc := newTokenTestVoiceService(t)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	// White-box: set IsServerMuted directly rather than via AdminUpdateState,
	// so this test stays isolated to GenerateToken's OWN read of the flag.
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box IsServerMuted override")
	}
	vs.mu.Lock()
	vs.states["u1"].IsServerMuted = true
	vs.mu.Unlock()

	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	grant := decodeVideoGrant(t, resp.Token, tokenTestAPISecret)
	if grant.CanPublish == nil || *grant.CanPublish {
		t.Errorf("expected CanPublish=false for a server-muted user, got %v", grant.CanPublish)
	}
}

func TestGenerateToken_NotServerMuted_CanPublishTrue(t *testing.T) {
	svc := newTokenTestVoiceService(t)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	grant := decodeVideoGrant(t, resp.Token, tokenTestAPISecret)
	if grant.CanPublish == nil || !*grant.CanPublish {
		t.Errorf("expected CanPublish=true (PermSpeak, not muted), got %v", grant.CanPublish)
	}
}

// TestGenerateToken_NoExistingState_CanPublishTrue pins the "state yoksa
// false varsay" decision: a genuinely fresh token request (no prior voice
// state at all) can never be for an already-muted user, since
// AdminUpdateState can only set IsServerMuted on an EXISTING voice state
// (see currentServerMute's own doc comment, voice_state.go).
func TestGenerateToken_NoExistingState_CanPublishTrue(t *testing.T) {
	svc := newTokenTestVoiceService(t)

	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	grant := decodeVideoGrant(t, resp.Token, tokenTestAPISecret)
	if grant.CanPublish == nil || !*grant.CanPublish {
		t.Errorf("expected CanPublish=true for a user with no prior voice state, got %v", grant.CanPublish)
	}
}

// TestGenerateToken_ServerDeafened_DoesNotAffectCanSubscribe pins the
// explicit non-goal: deafen is a local listening preference, not something
// server-mute-style enforcement should touch.
func TestGenerateToken_ServerDeafened_DoesNotAffectCanSubscribe(t *testing.T) {
	svc := newTokenTestVoiceService(t)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box IsServerDeafened override")
	}
	vs.mu.Lock()
	vs.states["u1"].IsServerDeafened = true
	vs.mu.Unlock()

	resp, err := svc.GenerateToken(context.Background(), "u1", "alice", "Alice", "ch1")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	grant := decodeVideoGrant(t, resp.Token, tokenTestAPISecret)
	if grant.CanSubscribe == nil || !*grant.CanSubscribe {
		t.Errorf("expected CanSubscribe=true even when server-deafened, got %v", grant.CanSubscribe)
	}
	if grant.CanPublish == nil || !*grant.CanPublish {
		t.Errorf("expected CanPublish=true (server-deafened alone must not mute), got %v", grant.CanPublish)
	}
}

// ─── buildServerMutePermission (pure logic — no LiveKit mocking needed) ───

func TestBuildServerMutePermission_NilCurrent_Muted(t *testing.T) {
	perm := buildServerMutePermission(nil, true)
	if perm.CanPublish {
		t.Error("expected CanPublish=false")
	}
	if !perm.CanSubscribe || !perm.CanPublishData {
		t.Errorf("expected CanSubscribe/CanPublishData defaults true, got %+v", perm)
	}
}

func TestBuildServerMutePermission_NilCurrent_Unmuted(t *testing.T) {
	perm := buildServerMutePermission(nil, false)
	if !perm.CanPublish {
		t.Error("expected CanPublish=true")
	}
}

// TestBuildServerMutePermission_PreservesOtherFields is the direct pin for
// the coordinator's core worry: UpdateParticipant's Permission field
// REPLACES the whole object, so every field but CanPublish must survive.
// Review LOW-D fix: now also sets/asserts Recorder and Agent (deprecated
// livekit fields, but still real struct fields proto.Clone must still
// carry forward) — the previous version of this test left them unset,
// which couldn't distinguish "preserved" from "always false anyway".
func TestBuildServerMutePermission_PreservesOtherFields(t *testing.T) {
	current := &livekit.ParticipantPermission{
		CanSubscribe:          true,
		CanPublish:            true, // must flip to false below
		CanPublishData:        true,
		Hidden:                true,
		Recorder:              true,
		CanUpdateMetadata:     true,
		Agent:                 true,
		CanSubscribeMetrics:   true,
		CanManageAgentSession: true,
		CanPublishSources:     []livekit.TrackSource{livekit.TrackSource_CAMERA},
	}

	perm := buildServerMutePermission(current, true)

	if perm.CanPublish {
		t.Error("expected CanPublish=false after muting")
	}
	if !perm.CanSubscribe || !perm.CanPublishData || !perm.Hidden || !perm.Recorder ||
		!perm.CanUpdateMetadata || !perm.Agent || !perm.CanSubscribeMetrics || !perm.CanManageAgentSession {
		t.Errorf("expected every other permission field preserved, got %+v", perm)
	}
	if len(perm.CanPublishSources) != 1 || perm.CanPublishSources[0] != livekit.TrackSource_CAMERA {
		t.Errorf("expected CanPublishSources preserved, got %v", perm.CanPublishSources)
	}
}

// TestBuildServerMutePermission_FieldCountGuard is a review LOW-D addition:
// pins the CURRENT field count of livekit.ParticipantPermission (10
// exported fields + 3 unexported protobuf-internal ones, as of
// github.com/livekit/protocol's pinned version). This exists specifically
// to fail loudly — not silently — the day a protocol-library bump adds a
// new permission field: TestBuildServerMutePermission_PreservesOtherFields
// above can only assert fields it already knows to set, so without this
// guard a newly-added field would be preserved-by-proto.Clone-accident
// with no test ever exercising it, and a future REGRESSION back to a
// field-by-field copy (the exact pre-review shape this whole file argued
// against) would go undetected until it silently dropped a permission in
// production.
func TestBuildServerMutePermission_FieldCountGuard(t *testing.T) {
	const wantFields = 13
	// Pointer-then-Elem, not a value literal: the struct embeds
	// protoimpl.MessageState (pragma.DoNotCopy), so reflect.TypeOf on a value
	// trips go vet's copylocks — which `go test`'s default vet subset does not
	// run, so it would only surface in CI's explicit `go vet ./...`.
	got := reflect.TypeOf((*livekit.ParticipantPermission)(nil)).Elem().NumField()
	if got != wantFields {
		t.Errorf("livekit.ParticipantPermission field count changed (got %d, want %d) — "+
			"a protocol-library bump likely added/removed a field; verify buildServerMutePermission "+
			"(via proto.Clone) still preserves it, update TestBuildServerMutePermission_PreservesOtherFields "+
			"to cover it, then update this guard's wantFields", got, wantFields)
	}
}

func TestBuildServerMutePermission_UnmuteRestoresCanPublish(t *testing.T) {
	current := &livekit.ParticipantPermission{
		CanSubscribe: true, CanPublishData: true, CanPublish: false, Hidden: true,
	}

	perm := buildServerMutePermission(current, false)

	if !perm.CanPublish {
		t.Error("expected CanPublish=true after unmuting")
	}
	if !perm.Hidden {
		t.Error("expected Hidden preserved across unmute")
	}
}

// ─── AdminUpdateState → LiveKit re-authorization dispatch ───

// TestAdminUpdateState_ServerMuteTransition_DispatchesLiveKitUpdate pins
// that a genuine mute/unmute TRANSITION dispatches the LiveKit
// re-authorization, that a repeated no-op call (already muted) does not
// re-dispatch, and that unmuting dispatches again.
func TestAdminUpdateState_ServerMuteTransition_DispatchesLiveKitUpdate(t *testing.T) {
	calls := make(chan string, 8)
	lkGetter := &mockConfigurableLiveKitGetter{
		GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
			calls <- serverID
			return nil, fmt.Errorf("no livekit instance in test") // applyServerMuteToLiveKit exits early — no network call
		},
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(lkGetter)
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls) // JoinChannel's own (unrelated) quota-tracking GetByServerID call

	truev := true
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", &truev, nil); err != nil {
		t.Fatalf("AdminUpdateState(mute): %v", err)
	}
	select {
	case got := <-calls:
		if got != "srv1" {
			t.Errorf("GetByServerID called with %q, want srv1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a LiveKit dispatch for the mute transition, timed out waiting")
	}

	// Repeating the SAME mute value is not a transition — must not re-dispatch.
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", &truev, nil); err != nil {
		t.Fatalf("AdminUpdateState(mute again): %v", err)
	}
	select {
	case got := <-calls:
		t.Errorf("expected no dispatch for a no-op mute call (already muted), got GetByServerID(%q)", got)
	case <-time.After(150 * time.Millisecond):
	}

	// Unmute IS a transition — must dispatch again.
	falsev := false
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", &falsev, nil); err != nil {
		t.Fatalf("AdminUpdateState(unmute): %v", err)
	}
	select {
	case got := <-calls:
		if got != "srv1" {
			t.Errorf("GetByServerID called with %q, want srv1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a LiveKit dispatch for the unmute transition, timed out waiting")
	}
}

// TestAdminUpdateState_DeafenOnly_DoesNotDispatchLiveKitUpdate pins that a
// deafen-only call (isServerMuted == nil) never touches LiveKit — deafen
// has no server-side enforcement, by design (see AdminUpdateState's doc
// comment).
func TestAdminUpdateState_DeafenOnly_DoesNotDispatchLiveKitUpdate(t *testing.T) {
	calls := make(chan string, 8)
	lkGetter := &mockConfigurableLiveKitGetter{
		GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
			calls <- serverID
			return nil, fmt.Errorf("no livekit instance in test")
		},
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(lkGetter)
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}
	drainCalls(calls)

	truev := true
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", nil, &truev); err != nil {
		t.Fatalf("AdminUpdateState(deafen only): %v", err)
	}

	select {
	case got := <-calls:
		t.Errorf("expected no LiveKit dispatch for a deafen-only call, got GetByServerID(%q)", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestAdminUpdateState_LiveKitUnreachable_StillSucceeds pins fail-open:
// AdminUpdateState's own return value and the server-side IsServerMuted
// flag must not depend on LiveKit being reachable — the LiveKit
// re-authorization is a best-effort enforcement layer on top of the
// already-authoritative in-memory state (and the GenerateToken gate on
// (re)connect), not a precondition for the mute to "count".
func TestAdminUpdateState_LiveKitUnreachable_StillSucceeds(t *testing.T) {
	svc, hub := newTestVoiceServiceWithLiveKitGetter(&mockLiveKitGetter{}) // always errors past channel lookup
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	truev := true
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", &truev, nil); err != nil {
		t.Fatalf("expected AdminUpdateState to succeed (fail-open) even though LiveKit is unreachable, got: %v", err)
	}
	state := svc.GetUserVoiceState("victim")
	if state == nil || !state.IsServerMuted {
		t.Errorf("expected IsServerMuted=true to still be applied to server-side state regardless of LiveKit reachability, got %+v", state)
	}
}

// ─── Review round 8: ordering / failure-mode / concurrency fixes ───

// TestAdminUpdateState_Unmute_RestoresLiveKitGrantBeforeBroadcast pins the
// HIGH-1 fix: on an UNMUTE transition, applyServerMuteToLiveKit's LiveKit
// call must be attempted BEFORE the WS broadcast reaches listeners.
// Otherwise the client's useMicSync reacts to the broadcast by immediately
// calling setMicrophoneEnabled(true) while LiveKit still has
// CanPublish=false — livekit-client throws a local 403 the client has no
// retry for (no ParticipantPermissionsChanged listener; see
// AdminUpdateState's own doc comment). Observes ordering via a single
// shared, mutex-protected log: GetByServerID (the first LiveKit call inside
// applyServerMuteToLiveKit, past the channel lookup) records "livekit_call",
// BroadcastToServerFn records "broadcast" — order[0] must be the former.
func TestAdminUpdateState_Unmute_RestoresLiveKitGrantBeforeBroadcast(t *testing.T) {
	var mu sync.Mutex
	var order []string
	record := func(what string) {
		mu.Lock()
		order = append(order, what)
		mu.Unlock()
	}

	lkGetter := &mockConfigurableLiveKitGetter{
		GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
			record("livekit_call")
			return nil, fmt.Errorf("no livekit instance in test") // applyServerMuteToLiveKit exits early — no network call
		},
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(lkGetter)
	hub.BroadcastToServerFn = func(_ string, ev ws.Event) {
		if ev.Op == ws.OpVoiceStateUpdate {
			record("broadcast")
		}
	}
	hub.BroadcastToUserFn = func(_ string, _ ws.Event) {}

	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatalf("initial join failed: %v", err)
	}

	// Pre-mute directly (white-box) so the AdminUpdateState call under test
	// below is a clean mute->unmute TRANSITION, without JoinChannel's own
	// GetByServerID quota-tracking call (recorded above) muddying the order
	// capture.
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box mute setup")
	}
	vs.mu.Lock()
	vs.states["victim"].IsServerMuted = true
	vs.mu.Unlock()

	mu.Lock()
	order = nil
	mu.Unlock()

	falsev := false
	if err := svc.AdminUpdateState(context.Background(), "admin", "victim", &falsev, nil); err != nil {
		t.Fatalf("AdminUpdateState(unmute): %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 {
		t.Fatalf("expected exactly 2 recorded events (livekit_call, broadcast), got %v", order)
	}
	if order[0] != "livekit_call" || order[1] != "broadcast" {
		t.Errorf("expected the LiveKit grant restore BEFORE the broadcast on unmute, got order %v", order)
	}
}

// tokenTestAPIKey/tokenTestAPISecret/tokenTestEncryptionKey (defined
// earlier, in the GenerateToken test section) are reused below.

// refusedLoopbackAddr returns a "host:port" string on 127.0.0.1 that is
// guaranteed to actively refuse a TCP connection: binds an ephemeral port,
// then closes it immediately. Whatever tries to connect afterward gets a
// real, fast connection-refused from the OS — no reliance on a specific
// low port number being unbound/permitted in whatever network namespace
// the test happens to run in.
func refusedLoopbackAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("setup: failed to reserve an ephemeral loopback port: %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("setup: failed to close reserved loopback port: %v", err)
	}
	return addr
}

// newServerMuteNetworkTestVoiceService builds a voiceService whose
// LiveKitInstanceGetter returns REAL crypto.Encrypt-ed fake credentials
// pointing at a guaranteed-refused loopback address. The address is a real
// OS-assigned ephemeral port, opened and immediately closed right before
// the test runs (see refusedLoopbackURL below) rather than a hardcoded
// port like 127.0.0.1:1 — a fixed low port can behave inconsistently
// across sandboxed/containerized network namespaces (permission-denied
// instead of connection-refused, or a different result depending on the
// runner), where an ephemeral port that this process itself just held is
// reliably "was listening, now refuses" everywhere including Docker (this
// suite's actual test-runner environment, which this file's own author
// cannot execute go test in to verify empirically). Still no DNS lookup
// involved (loopback IP literal), so still near-instant.
//
// Needed for the HIGH-2/MEDIUM-1 tests below: their whole point is
// attemptServerMuteUpdate's retry-vs-single-attempt behavior, which only
// diverges once GetByServerID + crypto.Decrypt succeed and
// roomClient.GetParticipant is actually ATTEMPTED — every other
// server-mute test in this file deliberately stops short of that (see the
// leading comment on the "LiveKit publish-grant enforcement" test section
// above) because the wire call isn't otherwise observable; here the
// wire-call ATTEMPT itself (fail via connection-refused, not its payload)
// is exactly what's under test. GetByServerIDFn also pushes onto
// setupCalls every time it runs — one call per independent
// applyServerMuteToLiveKit/removeParticipantFromLiveKit invocation (each
// does its own single GetByServerID in its own setup), which is how these
// tests distinguish "single mute attempt" from "unmute retry cycle, then
// eviction fallback" without any deeper wire-level mocking.
func newServerMuteNetworkTestVoiceService(t *testing.T, setupCalls chan string) (VoiceService, *testutil.MockBroadcaster) {
	t.Helper()
	encAPIKey, err := crypto.Encrypt(tokenTestAPIKey, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api key: %v", err)
	}
	encAPISecret, err := crypto.Encrypt(tokenTestAPISecret, tokenTestEncryptionKey)
	if err != nil {
		t.Fatalf("setup: encrypt api secret: %v", err)
	}
	refusedURL := "http://" + refusedLoopbackAddr(t)

	hub := &testutil.MockBroadcaster{}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
			},
		},
		&mockConfigurableLiveKitGetter{
			GetByServerIDFn: func(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
				setupCalls <- serverID
				return &models.LiveKitInstance{
					ID: "lk1", URL: refusedURL,
					APIKey: encAPIKey, APISecret: encAPISecret,
					IsPlatformManaged: false,
				}, nil
			},
		},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermAll, nil
			},
		},
		hub,
		nil, // onlineChecker
		&testutil.MockServerRepo{
			IsMemberFn: func(_ context.Context, _, _ string) (bool, error) { return true, nil },
		},
		tokenTestEncryptionKey,
		nil, // timeoutChecker
		nil, // banChecker
	)
	return svc, hub
}

// TestApplyServerMuteToLiveKit_UnmuteRetriesThenEvicts pins the HIGH-2 fix:
// when the LiveKit unmute call keeps failing, a live participant would
// otherwise be stuck at CanPublish=false with no client-side retry (the
// worst failure mode this whole feature guards against — see
// applyServerMuteToLiveKit's own doc comment). It must retry per
// serverMuteUnmuteRetryBackoffs and, on exhaustion, fall back to
// removeParticipantFromLiveKit so a forced reconnect gets a fresh,
// correctly-unmuted token. serverMuteUnmuteRetryBackoffs is shrunk for the
// duration of this test (package-level var — restored via defer) so it
// doesn't sleep through the real ~7s production schedule.
func TestApplyServerMuteToLiveKit_UnmuteRetriesThenEvicts(t *testing.T) {
	orig := serverMuteUnmuteRetryBackoffs
	serverMuteUnmuteRetryBackoffs = []time.Duration{5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond}
	defer func() { serverMuteUnmuteRetryBackoffs = orig }()

	setupCalls := make(chan string, 8)
	svc, _ := newServerMuteNetworkTestVoiceService(t, setupCalls)
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box call")
	}
	vs.mu.Lock()
	vs.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1", IsServerMuted: false}
	vs.mu.Unlock()

	// Direct white-box call — mirrors what AdminUpdateState's synchronous
	// unmute leg (HIGH-1) or its async mute-leg goroutine would invoke.
	vs.applyServerMuteToLiveKit("ch1", "victim")

	got := 0
	deadline := time.After(5 * time.Second)
	for got < 2 {
		select {
		case <-setupCalls:
			got++
		case <-deadline:
			t.Fatalf("expected 2 GetByServerID calls (applyServerMuteToLiveKit's own setup, then removeParticipantFromLiveKit's eviction fallback), got %d before timing out", got)
		}
	}

	select {
	case extra := <-setupCalls:
		t.Errorf("expected exactly 2 GetByServerID calls, got an unexpected extra one (%q)", extra)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestApplyServerMuteToLiveKit_ReDerivesTruthAtExecutionTime pins the
// MEDIUM-1 fix: applyServerMuteToLiveKit takes NO muted parameter and
// re-reads s.currentServerMute at the moment it actually runs, not at
// dispatch time — so a rapid mute→unmute pair converges on whatever is
// CURRENTLY true regardless of which goroutine's LiveKit call happens to
// land last. Exercised directly (white-box) rather than by racing real
// goroutines: the bug this closes is about what the function reads when it
// executes, not about which goroutine the Go scheduler happens to run
// first (the old, parameterized version was wrong on EVERY out-of-order
// completion, not just an unlucky scheduling — so deterministically
// flipping truth between "setup" and "run" exercises the exact same code
// path a real race would hit, without depending on scheduler timing).
//
// Distinguishes which branch ran via GetByServerID call count on the same
// network-reaching setup HIGH-2's test above uses: the mute branch makes
// exactly ONE GetByServerID call (single attempt, fail-open, no eviction);
// the unmute branch — expected here, since truth was flipped to unmuted
// before the call — retries (serverMuteUnmuteRetryBackoffs shrunk for test
// speed) and, on exhaustion, falls back to removeParticipantFromLiveKit,
// which does its own independent GetByServerID call, for two total.
func TestApplyServerMuteToLiveKit_ReDerivesTruthAtExecutionTime(t *testing.T) {
	orig := serverMuteUnmuteRetryBackoffs
	serverMuteUnmuteRetryBackoffs = []time.Duration{5 * time.Millisecond, 5 * time.Millisecond, 5 * time.Millisecond}
	defer func() { serverMuteUnmuteRetryBackoffs = orig }()

	setupCalls := make(chan string, 8)
	svc, _ := newServerMuteNetworkTestVoiceService(t, setupCalls)
	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box state control")
	}

	// "Dispatch time" (e.g. AdminUpdateState's mute leg captured this
	// intention when it fired off its goroutine): victim is muted.
	vs.mu.Lock()
	vs.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1", IsServerMuted: true}
	vs.mu.Unlock()

	// A second, later admin action (e.g. a fast follow-up unmute) flips
	// truth before the first action's goroutine actually runs.
	vs.mu.Lock()
	vs.states["victim"].IsServerMuted = false
	vs.mu.Unlock()

	// The "late" goroutine's execution: must converge on the CURRENT truth
	// (unmuted) rather than replaying the muted intention it would have
	// captured at dispatch time under the old muted-bool-parameter design.
	vs.applyServerMuteToLiveKit("ch1", "victim")

	got := 0
	deadline := time.After(5 * time.Second)
	for got < 2 {
		select {
		case <-setupCalls:
			got++
		case <-deadline:
			t.Fatalf("expected 2 GetByServerID calls (proving the unmute/retry/evict branch ran, not the 1-call mute branch), got %d before timing out", got)
		}
	}

	select {
	case extra := <-setupCalls:
		t.Errorf("expected exactly 2 GetByServerID calls, got an unexpected extra one (%q)", extra)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestEnforceModerationOnJoin_ServerMuted_ReappliesLiveKitGrant pins the
// MEDIUM-2 fix: a user who is neither timed out nor banned, but IS
// currently server-muted (currentServerMute), still gets their LiveKit
// publish grant re-applied on join — closing the token-TTL/same-server
// channel-switch freeze window described in EnforceModerationOnJoin's own
// doc comment. Observed via channelGetter.GetByID (applyServerMuteToLiveKit's
// first step) on the same calls channel newEvictionObservingChannelRepo
// already uses for eviction dispatches — exactly ONE call here, not two:
// this is a grant re-apply, not an eviction (no screen-share
// sub-participant lookup).
func TestEnforceModerationOnJoin_ServerMuted_ReappliesLiveKitGrant(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, _ string) (bool, error) { return false, nil },
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, _, _ string) (bool, error) { return false, nil },
		},
		newEvictionObservingChannelRepo(calls),
	)

	vs, ok := svc.(*voiceService)
	if !ok {
		t.Fatal("expected svc to be a *voiceService for white-box state setup")
	}
	vs.mu.Lock()
	vs.states["u1"] = &models.VoiceState{UserID: "u1", ChannelID: "ch1", ServerID: "srv1", IsServerMuted: true}
	vs.mu.Unlock()

	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")

	select {
	case got := <-calls:
		if got != "ch1" {
			t.Errorf("GetByID called with %q, want ch1", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected applyServerMuteToLiveKit to be dispatched for a server-muted joiner, timed out waiting")
	}
	select {
	case extra := <-calls:
		t.Errorf("expected exactly one dispatch (grant re-apply, not an eviction), got an extra GetByID(%q)", extra)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestEnforceModerationOnJoin_NotMuted_NoGrantReapply pins the negative
// case alongside MEDIUM-2: a joiner who is neither moderated nor
// server-muted triggers no dispatch at all. Reuses
// TestEnforceModerationOnJoin_NotModerated_NoOp's exact setup (no white-box
// state is written for "u1", so currentServerMute safely defaults to false
// per its own doc comment) — kept as its own test so a future change to
// either code path's negative case fails independently and legibly.
func TestEnforceModerationOnJoin_NotMuted_NoGrantReapply(t *testing.T) {
	calls := make(chan string, 8)
	svc, _ := newTestVoiceServiceWithModeration(
		&testutil.MockMemberTimeoutRepo{
			IsActiveFn: func(_ context.Context, _, _ string) (bool, error) { return false, nil },
		},
		&mockBanChecker{
			ExistsFn: func(_ context.Context, _, _ string) (bool, error) { return false, nil },
		},
		newEvictionObservingChannelRepo(calls),
	)
	svc.EnforceModerationOnJoin(context.Background(), "srv1", "ch1", "u1")
	expectNoEvictionDispatch(t, calls)
}
