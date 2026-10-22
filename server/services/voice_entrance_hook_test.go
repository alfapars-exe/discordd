package services

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

// entranceHookCall is one OnVoiceJoined dispatch seen by recordingEntranceHook.
type entranceHookCall struct {
	userID, serverID, channelID string
}

type recordingEntranceHook struct {
	calls chan entranceHookCall
}

func newRecordingEntranceHook() *recordingEntranceHook {
	return &recordingEntranceHook{calls: make(chan entranceHookCall, 8)}
}

func (h *recordingEntranceHook) OnVoiceJoined(userID, serverID, channelID string) {
	h.calls <- entranceHookCall{userID: userID, serverID: serverID, channelID: channelID}
}

func (h *recordingEntranceHook) expectCall(t *testing.T, want entranceHookCall) {
	t.Helper()
	select {
	case got := <-h.calls:
		if got != want {
			t.Errorf("OnVoiceJoined(%+v), want %+v", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("expected OnVoiceJoined(%+v), timed out", want)
	}
}

func (h *recordingEntranceHook) expectNoCall(t *testing.T) {
	t.Helper()
	select {
	case got := <-h.calls:
		t.Errorf("unexpected OnVoiceJoined(%+v)", got)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestJoinChannel_EntranceHook_FreshJoinFiresOnce(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hook := newRecordingEntranceHook()
	svc.SetEntranceHook(hook)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join failed: %v", err)
	}
	hook.expectCall(t, entranceHookCall{userID: "u1", serverID: "srv1", channelID: "ch1"})
	hook.expectNoCall(t)
}

func TestJoinChannel_EntranceHook_SameChannelRejoinDoesNotFire(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hook := newRecordingEntranceHook()
	svc.SetEntranceHook(hook)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join failed: %v", err)
	}
	hook.expectCall(t, entranceHookCall{userID: "u1", serverID: "srv1", channelID: "ch1"})

	// WS reconnect: same channel again → early return, no replay.
	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("rejoin failed: %v", err)
	}
	hook.expectNoCall(t)
}

func TestJoinChannel_EntranceHook_RejectedJoinDoesNotFire(t *testing.T) {
	svc, hub := newAuthVoiceService(false, func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermAll, nil
	})
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hook := newRecordingEntranceHook()
	svc.SetEntranceHook(hook)

	if err := svc.JoinChannel("intruder", "x", "X", "", "ch1", false, false); err == nil {
		t.Fatal("expected authorizeJoin to reject a non-member")
	}
	hook.expectNoCall(t)
}

func TestJoinChannel_EntranceHook_ChannelSwitchFiresForNewChannel(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	hook := newRecordingEntranceHook()
	svc.SetEntranceHook(hook)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join failed: %v", err)
	}
	hook.expectCall(t, entranceHookCall{userID: "u1", serverID: "srv1", channelID: "ch1"})

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch2", false, false); err != nil {
		t.Fatalf("switch failed: %v", err)
	}
	hook.expectCall(t, entranceHookCall{userID: "u1", serverID: "srv1", channelID: "ch2"})
}

func TestJoinChannel_EntranceHook_NilHookIsSafe(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(_ string, _ ws.Event) {}
	svc.SetEntranceHook(nil)

	if err := svc.JoinChannel("u1", "alice", "Alice", "", "ch1", false, false); err != nil {
		t.Fatalf("join with nil entrance hook failed: %v", err)
	}
}
