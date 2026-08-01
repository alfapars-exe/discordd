package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

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
	)
	return svc, hub
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
