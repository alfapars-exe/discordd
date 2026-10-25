package services

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type fanoutTestHub struct {
	testutil.MockEventPublisher
	online []string
}

func (h *fanoutTestHub) GetOnlineUserIDsForServer(string) []string { return h.online }

type fanoutTestMembers struct {
	ids []string
	err error
}

type fanoutTestChannels struct {
	channel *models.Channel
	lookup  func(context.Context) (*models.Channel, error)
}

func (c fanoutTestChannels) GetByID(ctx context.Context, _ string) (*models.Channel, error) {
	if c.lookup != nil {
		return c.lookup(ctx)
	}
	return c.channel, nil
}

func (m fanoutTestMembers) ListMemberIDs(context.Context, string) ([]string, error) {
	return m.ids, m.err
}

func (fanoutTestMembers) GetByID(context.Context, string) (*models.Server, error) {
	return nil, nil
}

func (fanoutTestMembers) IsMember(context.Context, string, string) (bool, error) {
	return true, nil
}

func newFanoutTestService(hub *fanoutTestHub, members fanoutTestMembers, resolve func(context.Context, string, []string) (map[string]models.Permission, error)) *voiceService {
	return &voiceService{
		channelGetter:    fanoutTestChannels{channel: &models.Channel{ID: "channel-1", ServerID: "server-1", Type: models.ChannelTypeVoice}},
		hub:              hub,
		permResolver:     &testutil.MockChannelPermResolver{ResolveChannelPermissionsBulkFn: resolve},
		afkTimeoutGetter: members,
	}
}

func TestVoiceStateFanoutRejectsCrossServerChannel(t *testing.T) {
	lookedUp := make(chan struct{}, 1)
	delivered := make(chan struct{}, 1)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func([]string, ws.Event) { delivered <- struct{}{} }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		t.Fatal("permission resolution should not run for a cross-server channel")
		return nil, nil
	})
	service.channelGetter = fanoutTestChannels{lookup: func(context.Context) (*models.Channel, error) {
		lookedUp <- struct{}{}
		return &models.Channel{ID: "channel-1", ServerID: "other-server", Type: models.ChannelTypeVoice}, nil
	}}
	service.voiceFanout = newVoiceStateFanout(service)
	service.voiceFanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}})
	select {
	case <-lookedUp:
	case <-time.After(time.Second):
		service.voiceFanout.shutdown()
		t.Fatal("worker did not perform channel scope check")
	}
	service.voiceFanout.shutdown()
	if service.voiceFanout.dropped() == 0 {
		t.Fatal("expected the cross-server event to be rejected")
	}
	select {
	case <-delivered:
		t.Fatal("cross-server channel event was delivered")
	default:
	}
}

func TestVoiceStateFanoutSnapshotsPointerPayloadBeforeQueueing(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	delivered := make(chan ws.Event, 1)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func(_ []string, event ws.Event) { delivered <- event }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		return map[string]models.Permission{"member": models.PermViewChannel}, nil
	})
	service.channelGetter = fanoutTestChannels{lookup: func(ctx context.Context) (*models.Channel, error) {
		close(entered)
		select {
		case <-release:
			return &models.Channel{ID: "channel-1", ServerID: "server-1", Type: models.ChannelTypeVoice}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	service.voiceFanout = newVoiceStateFanout(service)
	defer service.voiceFanout.shutdown()

	payload := &ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1", UserID: "original"}
	service.voiceFanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: payload})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not enter channel lookup")
	}
	payload.UserID = "mutated-after-submit"
	close(release)
	select {
	case event := <-delivered:
		got, ok := event.Data.(ws.VoiceStateUpdateBroadcast)
		if !ok || got.UserID != "original" {
			t.Fatalf("queued payload was not snapshotted: %#v", event.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("fanout did not deliver")
	}
}

func TestVoiceStateFanoutFiltersMembershipAndViewPermission(t *testing.T) {
	delivered := make(chan struct {
		ids   []string
		event ws.Event
	}, 1)
	hub := &fanoutTestHub{online: []string{"visible", "hidden", "not-member", "visible"}}
	hub.BroadcastToUsersFn = func(ids []string, event ws.Event) {
		delivered <- struct {
			ids   []string
			event ws.Event
		}{append([]string(nil), ids...), event}
	}
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"visible", "hidden"}}, func(_ context.Context, channelID string, ids []string) (map[string]models.Permission, error) {
		if channelID != "channel-1" || !reflect.DeepEqual(ids, []string{"visible", "hidden"}) {
			t.Fatalf("unexpected permission request channel=%q ids=%v", channelID, ids)
		}
		return map[string]models.Permission{
			"visible": models.PermViewChannel,
			"hidden":  models.PermConnectVoice,
		}, nil
	})
	service.voiceFanout = newVoiceStateFanout(service)
	defer service.voiceFanout.shutdown()

	service.voiceFanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}})
	select {
	case got := <-delivered:
		if !reflect.DeepEqual(got.ids, []string{"visible"}) {
			t.Fatalf("unexpected recipients: %v", got.ids)
		}
		if got.event.ServerID != "server-1" {
			t.Fatalf("server envelope lost: %q", got.event.ServerID)
		}
	case <-time.After(time.Second):
		t.Fatal("fanout did not deliver")
	}
}

func TestVoiceStateFanoutFailsClosedOnResolverError(t *testing.T) {
	resolved := make(chan struct{}, 1)
	delivered := make(chan struct{}, 1)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func([]string, ws.Event) { delivered <- struct{}{} }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		resolved <- struct{}{}
		return nil, errors.New("resolver unavailable")
	})
	service.voiceFanout = newVoiceStateFanout(service)
	service.voiceFanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}})
	select {
	case <-resolved:
	case <-time.After(time.Second):
		service.voiceFanout.shutdown()
		t.Fatal("worker did not invoke permission resolver")
	}
	service.voiceFanout.shutdown()
	select {
	case <-delivered:
		t.Fatal("resolver failure delivered an event")
	default:
	}
}

func TestVoiceStateFanoutDropsOnQueueSaturation(t *testing.T) {
	// The resolver can run before the test reaches its receive. Buffer the
	// notification so the nonblocking send cannot lose that handshake.
	entered, release := make(chan struct{}, 1), make(chan struct{})
	hub := &fanoutTestHub{online: []string{"member"}}
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(ctx context.Context, _ string, _ []string) (map[string]models.Permission, error) {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return map[string]models.Permission{"member": models.PermViewChannel}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	service.voiceFanout = newVoiceStateFanout(service)
	fanout := service.voiceFanout
	defer fanout.shutdown()
	item := ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}}
	fanout.submit("server-1", item)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not enter resolver")
	}
	for i := 0; i < voiceStateFanoutQueueLimit; i++ {
		fanout.submit("server-1", item)
	}
	fanout.submit("server-1", item)
	if got := fanout.dropped(); got != 1 {
		t.Fatalf("expected one fail-closed queue drop, got %d", got)
	}
	close(release)
}

func TestVoiceStateFanoutPreservesAcceptedFIFOOrder(t *testing.T) {
	delivered := make(chan string, 3)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func(_ []string, event ws.Event) {
		delivered <- event.Data.(ws.VoiceStateUpdateBroadcast).Action
	}
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		return map[string]models.Permission{"member": models.PermViewChannel}, nil
	})
	service.voiceFanout = newVoiceStateFanout(service)
	defer service.voiceFanout.shutdown()
	for _, action := range []string{"join", "update", "leave"} {
		service.voiceFanout.submit("server-1", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1", Action: action}})
	}
	got := make([]string, 0, 3)
	for len(got) < 3 {
		select {
		case action := <-delivered:
			got = append(got, action)
		case <-time.After(time.Second):
			t.Fatalf("received FIFO events %v, timed out", got)
		}
	}
	if want := []string{"join", "update", "leave"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("accepted fanout order %v, want %v", got, want)
	}
}

func TestVoiceStateFanoutWorkerRestartsAfterIdleExit(t *testing.T) {
	delivered := make(chan struct{}, 2)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func([]string, ws.Event) { delivered <- struct{}{} }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(context.Context, string, []string) (map[string]models.Permission, error) {
		return map[string]models.Permission{"member": models.PermViewChannel}, nil
	})
	service.voiceFanout = newVoiceStateFanout(service)
	fanout := service.voiceFanout
	defer fanout.shutdown()
	item := ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}}
	fanout.submit("server-1", item)
	select {
	case <-delivered:
	case <-time.After(time.Second):
		t.Fatal("first event was not delivered")
	}
	deadline := time.NewTimer(voiceStateFanoutIdle + time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		fanout.mu.Lock()
		idle := !fanout.worker
		fanout.mu.Unlock()
		if idle {
			break
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("worker did not exit after becoming idle")
		}
	}
	fanout.submit("server-1", item)
	select {
	case <-delivered:
	case <-time.After(time.Second):
		t.Fatal("worker did not restart for subsequent event")
	}
}

func TestVoiceStateFanoutShutdownCancelsAndRejectsFurtherEvents(t *testing.T) {
	entered := make(chan struct{}, 1)
	delivered := make(chan struct{}, 1)
	hub := &fanoutTestHub{online: []string{"member"}}
	hub.BroadcastToUsersFn = func([]string, ws.Event) { delivered <- struct{}{} }
	service := newFanoutTestService(hub, fanoutTestMembers{ids: []string{"member"}}, func(ctx context.Context, _ string, _ []string) (map[string]models.Permission, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	service.voiceFanout = newVoiceStateFanout(service)
	fanout := service.voiceFanout
	item := ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "channel-1"}}
	fanout.submit("server-1", item)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("resolver did not start")
	}
	fanout.shutdown()
	droppedBefore := fanout.dropped()
	fanout.submit("server-1", item)
	if fanout.dropped() != droppedBefore+1 {
		t.Fatalf("post-shutdown event was not rejected: drop count %d -> %d", droppedBefore, fanout.dropped())
	}
	select {
	case <-delivered:
		t.Fatal("shutdown-canceled event was delivered")
	default:
	}
}
