package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

func TestVoiceStateFanoutFIFOAndIdleRestart(t *testing.T) {
	delivered := make(chan string, 20)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func(_ []string, event ws.Event) { delivered <- event.Data.(ws.VoiceStateUpdateBroadcast).UserID }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		return map[string]models.Permission{"member": models.PermViewChannel}, nil
	})
	fanout := newVoiceStateFanout(service)
	defer fanout.shutdown()
	for i := 0; i < 20; i++ {
		fanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1", UserID: fmt.Sprint(i)}})
	}
	for i := 0; i < 20; i++ {
		select {
		case got := <-delivered:
			if got != fmt.Sprint(i) {
				t.Fatalf("FIFO got=%s want=%d", got, i)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("delivery timeout")
		}
	}
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		fanout.mu.Lock()
		idle := !fanout.worker
		fanout.mu.Unlock()
		if idle {
			break
		}
		select {
		case <-deadline:
			t.Fatal("worker failed to exit when idle")
		case <-ticker.C:
		}
	}
	fanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1", UserID: "restart"}})
	select {
	case got := <-delivered:
		if got != "restart" {
			t.Fatalf("restart delivered %s", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle worker did not restart")
	}
}

func TestSnapshotVoiceEventCopiesViewerIDs(t *testing.T) {
	ids := []string{"viewer-a", "viewer-b"}
	_, snapshot, ok := snapshotVoiceEvent(ws.Event{
		Op:   ws.OpScreenShareViewerUpdate,
		Data: ws.ScreenShareViewerUpdateData{ChannelID: "channel-1", ViewerUserIDs: ids},
	})
	if !ok {
		t.Fatal("screen-share event was rejected")
	}
	ids[0] = "mutated"
	got := snapshot.Data.(ws.ScreenShareViewerUpdateData).ViewerUserIDs
	if got[0] != "viewer-a" {
		t.Fatalf("queued event retained mutable caller slice: %v", got)
	}
}

func TestVoiceStateFanoutShutdownCancelsActiveAndRejectsLaterSubmissions(t *testing.T) {
	entered := make(chan struct{})
	delivered := make(chan struct{}, 1)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func([]string, ws.Event) { delivered <- struct{}{} }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(ctx context.Context, _ string, _ []string) (map[string]models.Permission, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	fanout := newVoiceStateFanout(service)
	defer fanout.shutdown()
	event := ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}}
	fanout.submit("server-1", event)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not enter resolver")
	}
	stopped := make(chan struct{})
	go func() { fanout.shutdown(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel active lookup")
	}
	before := fanout.dropped()
	fanout.submit("server-1", event)
	if fanout.dropped() != before+1 {
		t.Fatal("post-shutdown event was not rejected")
	}
	select {
	case <-delivered:
		t.Fatal("cancelled lookup delivered an event")
	default:
	}
}
