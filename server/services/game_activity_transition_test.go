package services

import (
	"context"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"sync"
	"testing"
	"time"
)

type transitionPolicy struct {
	visible    bool
	beforeView func()
}

func (p *transitionPolicy) CanPublish(context.Context, string) (bool, error) { return true, nil }
func (p *transitionPolicy) CanView(context.Context, string, string, string) (bool, error) {
	if p.beforeView != nil {
		p.beforeView()
	}
	return p.visible, nil
}

func TestGameActivityLiveTransitionDoesNotReplayForSnapshotsPolicyRenameOrFallback(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	var events []ws.GameActivityData
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(_ []string, event ws.Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event.Data.(ws.GameActivityData))
	}}
	policy := &transitionPolicy{visible: true}
	svc := NewGameActivityService(policy, activityServiceFriends{}, activityMembershipServers{members: map[string]bool{"host": true, "viewer": true}}, hub)
	take := func() []ws.GameActivityData {
		mu.Lock()
		defer mu.Unlock()
		result := events
		events = nil
		return result
	}
	assertTransition := func(rows []ws.GameActivityData, want bool) {
		t.Helper()
		found := false
		for _, row := range rows {
			if row.UserID == "host" && row.ServerID == "" && row.Transition {
				found = true
			}
			if row.Transition && (row.ServerID != "" || row.Game == nil) {
				t.Fatal("transition leaked outside global active context")
			}
		}
		if found != want {
			t.Fatalf("transition=%v want=%v rows=%+v", found, want, rows)
		}
	}
	svc.Connect("host", 1)
	a := &ws.GameActivityClientGame{ID: "game-a", Name: "Game A", CanonicalGameID: "steam:730"}
	svc.Update(ctx, "host", 1, 1, a)
	rows := take()
	assertTransition(rows, true)
	for _, row := range rows {
		if row.Transition && row.UserID != "host" {
			t.Fatal("wrong source identity")
		}
	}
	svc.Snapshot(ctx, "viewer")
	assertTransition(take(), false)
	svc.PolicyChanged(ctx, "host")
	assertTransition(take(), false)
	svc.Update(ctx, "host", 1, 2, a)
	assertTransition(take(), false)
	renamed := *a
	renamed.Name = "Renamed label"
	svc.Update(ctx, "host", 1, 3, &renamed)
	assertTransition(take(), false)
	policy.visible = false
	svc.PolicyChanged(ctx, "host")
	assertTransition(take(), false)
	policy.visible = true
	svc.PolicyChanged(ctx, "host")
	assertTransition(take(), false)
	time.Sleep(time.Millisecond)
	b := &ws.GameActivityClientGame{ID: "game-b", Name: "Game B"}
	svc.Update(ctx, "host", 1, 4, b)
	assertTransition(take(), true)
	svc.Connect("host", 2)
	time.Sleep(time.Millisecond)
	svc.Update(ctx, "host", 2, 1, a)
	assertTransition(take(), true)
	svc.Update(ctx, "host", 1, 5, b)
	assertTransition(take(), false)
	svc.Disconnect(ctx, "host", 2)
	assertTransition(take(), false)
	svc.Update(ctx, "host", 1, 6, nil)
	assertTransition(take(), false)
}

func TestGameActivityOwnerNeverReceivesTransitionAndUnselectedCandidateCannotNotify(t *testing.T) {
	ctx := context.Background()
	var recipients []string
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
		data := event.Data.(ws.GameActivityData)
		if data.Transition {
			recipients = append(recipients, ids...)
		}
	}}
	svc := NewGameActivityService(&transitionPolicy{visible: true}, activityServiceFriends{}, activityServiceServers{}, hub)
	svc.Connect("host", 1)
	svc.Update(ctx, "host", 1, 1, &ws.GameActivityClientGame{ID: "a", Name: "A"})
	if len(recipients) != 1 || recipients[0] != "viewer" {
		t.Fatal("owner or foreign context received marker", recipients)
	}
	svc.mu.Lock()
	if svc.selectedTransitionLocked("host", gameActivityTransition{connection: 1, incarnation: "old"}, time.Now()) {
		t.Fatal("old incarnation accepted")
	}
	svc.mu.Unlock()
}

func TestGameActivityTransitionRechecksSourceLeaseAfterFreshPolicy(t *testing.T) {
	ctx := context.Background()
	count := 0
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(_ []string, event ws.Event) {
		if event.Data.(ws.GameActivityData).Transition {
			count++
		}
	}}
	policy := &transitionPolicy{visible: true}
	svc := NewGameActivityService(policy, activityServiceFriends{}, activityServiceServers{}, hub)
	policy.beforeView = func() {
		svc.mu.Lock()
		defer svc.mu.Unlock()
		for id, source := range svc.sources["host"] {
			source.leaseUntil = time.Now().Add(-time.Second)
			svc.sources["host"][id] = source
		}
	}
	svc.Connect("host", 1)
	svc.Update(ctx, "host", 1, 1, &ws.GameActivityClientGame{ID: "a", Name: "A"})
	if count != 0 {
		t.Fatal("expired source emitted live transition after policy lookup")
	}
}
