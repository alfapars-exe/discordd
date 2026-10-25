package ws

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/pkg"
	"sync"
	"testing"
	"time"
)

func TestGameJoinPhysicalSessionFreshCheckOutsideHubLock(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "host", connectionID: 7, sessionID: "host-session"}
	h.clients["host"] = map[*Client]bool{c: true}
	calls := 0
	c.validateSession = func(ctx context.Context, user, sid string) error {
		calls++
		h.mu.Lock()
		h.mu.Unlock()
		if user != "host" || sid != "host-session" {
			t.Fatal("wrong session projection")
		}
		return pkg.ErrUnauthorized
	}
	if err := h.ValidateGameActivityConnection(context.Background(), "host", 7); !errors.Is(err, pkg.ErrUnauthorized) || calls != 1 {
		t.Fatal("fresh revoked session check missing", err)
	}
	if err := h.ValidateGameActivityConnection(context.Background(), "host", 8); !errors.Is(err, pkg.ErrForbidden) || calls != 1 {
		t.Fatal("foreign connection looked up session", err)
	}
	c.isBot = true
	if err := h.ValidateGameActivityConnection(context.Background(), "host", 7); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatal("bot joined game")
	}
}
func TestGameJoinFinalAdmissionSerializesPhysicalRemoval(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "host", connectionID: 7}
	h.clients["host"] = map[*Client]bool{c: true}
	inside, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- h.WithGameActivityConnection("host", 7, func() error { close(inside); <-release; return nil })
	}()
	<-inside
	removed := make(chan struct{})
	started := make(chan struct{})
	go func() { close(started); h.mu.Lock(); delete(h.clients["host"], c); h.mu.Unlock(); close(removed) }()
	<-started
	select {
	case <-removed:
		t.Fatal("removal raced admitted commit")
	default:
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	<-removed
	called := false
	if err := h.WithGameActivityConnection("host", 7, func() error { called = true; return nil }); !errors.Is(err, pkg.ErrForbidden) || called {
		t.Fatal("removed source admitted", err)
	}
}
func TestGameJoinOfferSharesActivityQueueAndAcknowledgesOnlyPhysicalSender(t *testing.T) {
	h := NewHub()
	t.Cleanup(h.presenceCallbacks.shutdown)
	a := &Client{hub: h, userID: "host", connectionID: 7, send: make(chan []byte, 8), done: make(chan struct{})}
	b := &Client{hub: h, userID: "host", connectionID: 8, send: make(chan []byte, 8), done: make(chan struct{})}
	h.clients["host"] = map[*Client]bool{a: true, b: true}
	var mu sync.Mutex
	var calls []string
	h.OnGameActivityUpdate(func(string, uint64, uint64, *GameActivityClientGame) {
		mu.Lock()
		calls = append(calls, "update")
		mu.Unlock()
	})
	h.OnGameJoinOffer(func(user string, connection uint64, raw any) any {
		if user != "host" || connection != 7 {
			t.Error("offer identity not physical")
		}
		mu.Lock()
		calls = append(calls, "offer")
		mu.Unlock()
		return map[string]any{"accepted": true}
	})
	a.handleGameActivityUpdate(Event{Data: GameActivityClientUpdate{Game: &GameActivityClientGame{ID: "11111111-1111-4111-8111-111111111111", Name: "CS2", CanonicalGameID: "steam:730"}}})
	a.handleGameJoinOffer(Event{Data: map[string]any{}})
	select {
	case raw := <-a.send:
		var event Event
		if json.Unmarshal(raw, &event) != nil || event.Op != "game_join_offer_state" {
			t.Fatal("missing offer ack")
		}
	case <-time.After(time.Second):
		t.Fatal("offer callback never completed")
	}
	select {
	case <-b.send:
		t.Fatal("private recipe/ack broadcast to another tab")
	default:
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 || calls[0] != "update" || calls[1] != "offer" {
		t.Fatal("offer reordered ahead of activity", calls)
	}
}
