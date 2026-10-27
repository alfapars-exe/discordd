package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type activityServiceFriends struct{}

func (activityServiceFriends) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}
func (activityServiceFriends) IsBlocked(context.Context, string, string) (bool, error) {
	return false, nil
}
func (activityServiceFriends) ListFriends(context.Context, string) ([]models.FriendshipWithUser, error) {
	return []models.FriendshipWithUser{{UserID: "viewer", Status: models.FriendshipStatusAccepted}}, nil
}

type activityServiceServers struct{}

func (activityServiceServers) IsMember(context.Context, string, string) (bool, error) {
	return false, nil
}
func (activityServiceServers) GetMemberCount(context.Context, string) (int, error) { return 0, nil }
func (activityServiceServers) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	return nil, nil
}
func (activityServiceServers) ListMemberIDs(context.Context, string) ([]string, error) {
	return nil, nil
}

type activityMembershipServers struct{ members map[string]bool }

func (s activityMembershipServers) IsMember(_ context.Context, _ string, userID string) (bool, error) {
	return s.members[userID], nil
}
func (activityMembershipServers) GetMemberCount(context.Context, string) (int, error) { return 0, nil }
func (s activityMembershipServers) GetUserServers(_ context.Context, userID string) ([]models.ServerListItem, error) {
	if s.members[userID] {
		return []models.ServerListItem{{ID: "server-1"}}, nil
	}
	return nil, nil
}
func (s activityMembershipServers) ListMemberIDs(context.Context, string) ([]string, error) {
	var members []string
	for userID, isMember := range s.members {
		if isMember {
			members = append(members, userID)
		}
	}
	return members, nil
}

type activityPolicyStub struct{ viewErr error }

func (p *activityPolicyStub) CanPublish(context.Context, string) (bool, error) { return true, nil }
func (p *activityPolicyStub) CanView(context.Context, string, string, string) (bool, error) {
	if p.viewErr != nil {
		return false, p.viewErr
	}
	return true, nil
}

func TestGameActivityServiceKeepsPerConnectionSourcesAndDoesNotFloodRenewals(t *testing.T) {
	var mu sync.Mutex
	var events []ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) != 1 || ids[0] != "viewer" {
			return // owner self-view is an independent, targeted context
		}
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	}}
	policy := gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{}, gameActivityPresenceStub{visible: true}, nil)
	svc := NewGameActivityService(policy, activityServiceFriends{}, activityServiceServers{}, hub)
	ctx := context.Background()
	svc.Connect("target", 1)
	svc.Connect("target", 2)
	a := &ws.GameActivityClientGame{ID: "a", Name: "Game A"}
	b := &ws.GameActivityClientGame{ID: "b", Name: "Game B"}
	svc.Update(ctx, "target", 1, 1, a)
	time.Sleep(time.Millisecond)
	svc.Update(ctx, "target", 2, 1, b)
	svc.Update(ctx, "target", 1, 2, a) // renew older source; it must not take ownership or publish
	mu.Lock()
	got := append([]ws.Event(nil), events...)
	mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("events after two changes and renewal = %d, want 2", len(got))
	}
	if data := got[1].Data.(ws.GameActivityData); data.Game == nil || data.Game.ID != "b" {
		t.Fatalf("selected game after renewal = %#v, want Game B", data.Game)
	}
	svc.Disconnect(ctx, "target", 2)
	mu.Lock()
	got = append([]ws.Event(nil), events...)
	mu.Unlock()
	if len(got) != 3 || got[2].Data.(ws.GameActivityData).Game.ID != "a" {
		t.Fatalf("disconnect did not fall back to remaining source: %#v", got)
	}
	svc.Disconnect(ctx, "target", 1)
	mu.Lock()
	defer mu.Unlock()
	if len(events) != 4 || events[3].Data.(ws.GameActivityData).Game != nil {
		t.Fatalf("last disconnect did not revoke activity: %#v", events)
	}
}

func TestGameActivityServiceSequenceAndDisconnectFence(t *testing.T) {
	var events []ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) == 1 && ids[0] == "viewer" {
			events = append(events, event)
		}
	}}
	svc := NewGameActivityService(gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{}, gameActivityPresenceStub{visible: true}, nil), activityServiceFriends{}, activityServiceServers{}, hub)
	ctx := context.Background()
	game := &ws.GameActivityClientGame{ID: "x", Name: "X"}
	svc.Connect("target", 7)
	svc.Update(ctx, "target", 7, 1, game)
	svc.Update(ctx, "target", 7, 3, nil)  // newer clear is authoritative
	svc.Update(ctx, "target", 7, 2, game) // delayed old update is ignored
	if len(events) != 2 || events[1].Data.(ws.GameActivityData).Game != nil {
		t.Fatalf("out-of-order clear handling: %#v", events)
	}
	svc.Disconnect(ctx, "target", 7)
	svc.Update(ctx, "target", 7, 4, game) // dead physical connection cannot resurrect
	if len(events) != 2 {
		t.Fatalf("post-disconnect update resurrected state: %#v", events)
	}
}

func TestGameActivityServiceExpiredLeaseRevokesImmediately(t *testing.T) {
	var events []ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) == 1 && ids[0] == "viewer" {
			events = append(events, event)
		}
	}}
	svc := NewGameActivityService(gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{}, gameActivityPresenceStub{visible: true}, nil), activityServiceFriends{}, activityServiceServers{}, hub)
	svc.Connect("target", 1)
	svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "x", Name: "X"})
	svc.mu.Lock()
	source := svc.sources["target"][1]
	source.leaseUntil = time.Now().Add(-time.Second)
	svc.sources["target"][1] = source
	svc.mu.Unlock()
	svc.ExpireAndReconcile(context.Background())
	if len(events) != 2 || events[1].Data.(ws.GameActivityData).Game != nil {
		t.Fatalf("expired lease did not revoke immediately: %#v", events)
	}
}

func TestGameActivityServiceStartedWorkerExpiresLeaseAndStopJoins(t *testing.T) {
	events := make(chan ws.Event, 4)
	ticks := make(chan time.Time, 1)
	stoppedTicker := make(chan struct{})
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) == 1 && ids[0] == "viewer" {
			events <- event
		}
	}}
	policy := gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{}, gameActivityPresenceStub{visible: true}, nil)
	svc := NewGameActivityService(policy, activityServiceFriends{}, activityServiceServers{}, hub)
	svc.tickerFactory = func(interval time.Duration) (<-chan time.Time, func()) {
		if interval != 10*time.Second {
			t.Errorf("worker interval = %s, want 10s", interval)
		}
		return ticks, func() { close(stoppedTicker) }
	}
	svc.Connect("target", 1)
	svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "x", Name: "X"})
	select {
	case <-events: // initial publication
	default:
		t.Fatal("initial activity publication was not emitted")
	}
	svc.mu.Lock()
	source := svc.sources["target"][1]
	source.leaseUntil = time.Now().Add(-time.Second)
	svc.sources["target"][1] = source
	svc.mu.Unlock()

	svc.Start()
	svc.Start() // duplicate lifecycle calls must not create another worker
	ticks <- time.Now()
	select {
	case event := <-events:
		data, ok := event.Data.(ws.GameActivityData)
		if !ok || data.Game != nil {
			t.Fatalf("expiry event = %#v, want revocation", event.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("started worker did not process the expiry tick")
	}
	svc.Stop()
	svc.Stop() // Stop is idempotent and waits for worker completion
	select {
	case <-stoppedTicker:
	default:
		t.Fatal("Stop returned before stopping the worker ticker")
	}
	select {
	case <-svc.workerDone:
	default:
		t.Fatal("Stop returned before the expiry worker exited")
	}
	svc.mu.Lock()
	_, remains := svc.sources["target"]
	svc.mu.Unlock()
	if remains {
		t.Fatal("expired source remains after worker reconciliation")
	}
}

func TestGameActivityServiceExpiryKeepsSelectedSourceAndSwitchesDirectlyToFallback(t *testing.T) {
	newService := func(t *testing.T) (*GameActivityService, *[]ws.Event) {
		t.Helper()
		events := []ws.Event{}
		hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
			if len(ids) == 1 && ids[0] == "viewer" {
				events = append(events, event)
			}
		}}
		policy := gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{}, gameActivityPresenceStub{visible: true}, nil)
		return NewGameActivityService(policy, activityServiceFriends{}, activityServiceServers{}, hub), &events
	}

	t.Run("expired non-selected source does not clear current game", func(t *testing.T) {
		svc, events := newService(t)
		svc.Connect("target", 1)
		svc.Connect("target", 2)
		svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "a", Name: "A"})
		time.Sleep(time.Millisecond)
		svc.Update(context.Background(), "target", 2, 1, &ws.GameActivityClientGame{ID: "b", Name: "B"})
		svc.mu.Lock()
		stale := svc.sources["target"][1]
		stale.leaseUntil = time.Now().Add(-time.Second)
		svc.sources["target"][1] = stale
		svc.mu.Unlock()
		svc.ExpireAndReconcile(context.Background())
		if len(*events) != 2 {
			t.Fatalf("expiry events = %d, want only the two explicit game changes", len(*events))
		}
		if got := (*events)[1].Data.(ws.GameActivityData).Game.ID; got != "b" {
			t.Fatalf("selected game after stale expiry = %q, want b", got)
		}
	})

	t.Run("expired selected source switches directly to live fallback", func(t *testing.T) {
		svc, events := newService(t)
		svc.Connect("target", 1)
		svc.Connect("target", 2)
		svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "a", Name: "A"})
		time.Sleep(time.Millisecond)
		svc.Update(context.Background(), "target", 2, 1, &ws.GameActivityClientGame{ID: "b", Name: "B"})
		svc.mu.Lock()
		selected := svc.sources["target"][2]
		selected.leaseUntil = time.Now().Add(-time.Second)
		svc.sources["target"][2] = selected
		svc.mu.Unlock()
		svc.ExpireAndReconcile(context.Background())
		if len(*events) != 3 {
			t.Fatalf("expiry events = %d, want direct fallback transition", len(*events))
		}
		last := (*events)[2].Data.(ws.GameActivityData).Game
		if last == nil || last.ID != "a" {
			t.Fatalf("fallback transition = %#v, want game a without null gap", last)
		}
	})
}

func TestGameActivityServicePolicyErrorRevokesThenCanRegrant(t *testing.T) {
	var events []ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) == 1 && ids[0] == "viewer" {
			events = append(events, event)
		}
	}}
	policy := &activityPolicyStub{}
	svc := NewGameActivityService(policy, activityServiceFriends{}, activityServiceServers{}, hub)
	svc.Connect("target", 1)
	svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "x", Name: "X"})
	policy.viewErr = context.DeadlineExceeded
	svc.ReconcileTarget(context.Background(), "target")
	if len(events) != 2 || events[1].Data.(ws.GameActivityData).Game != nil {
		t.Fatalf("policy read error did not revoke: %#v", events)
	}
	if _, ok := svc.sources["target"]; !ok {
		t.Fatal("policy read error discarded active source")
	}
	policy.viewErr = nil
	svc.ReconcileTarget(context.Background(), "target")
	if len(events) != 3 || events[2].Data.(ws.GameActivityData).Game == nil {
		t.Fatalf("grant was not restored after policy recovered: %#v", events)
	}
}

func TestGameActivityMembershipRemovalRevokesOnlyServerContextImmediately(t *testing.T) {
	var events []ws.Event
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		if len(ids) == 1 && ids[0] == "viewer" {
			events = append(events, event)
		}
	}}
	servers := activityMembershipServers{members: map[string]bool{"target": true, "viewer": true}}
	policy := gameActivityPolicy(`{"privacy":{"shareGameActivity":true}}`, gameActivityFriendsStub{accepted: true}, gameActivityServersStub{members: map[string]map[string]bool{"server-1": {"target": true, "viewer": true}}, snapshots: map[string]bool{"server-1": true}}, gameActivityPresenceStub{visible: true}, nil)
	svc := NewGameActivityService(policy, activityServiceFriends{}, servers, hub)
	svc.Connect("target", 1)
	svc.Update(context.Background(), "target", 1, 1, &ws.GameActivityClientGame{ID: "x", Name: "X"})
	var serverGrant bool
	for _, event := range events {
		data := event.Data.(ws.GameActivityData)
		if data.ServerID == "server-1" && data.Game != nil {
			serverGrant = true
		}
	}
	if !serverGrant {
		t.Fatalf("setup did not deliver the server-context grant: %#v", events)
	}

	servers.members["viewer"] = false // server removal has committed
	svc.MembershipRemoved(context.Background(), "server-1", "viewer")
	var serverTombstone, globalStillPublished bool
	for _, event := range events {
		data := event.Data.(ws.GameActivityData)
		if data.ServerID == "server-1" && data.Game == nil {
			serverTombstone = true
		}
		if data.ServerID == "" && data.Game != nil {
			globalStillPublished = true
		}
	}
	if !serverTombstone || !globalStillPublished {
		t.Fatalf("membership removal did not revoke only server context: %#v", events)
	}
}
