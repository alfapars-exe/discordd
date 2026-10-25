package ws

import (
	"testing"
	"time"
)

func TestGameActivityClientCannotInjectServerTransitionMarker(t *testing.T) {
	h := NewHub()
	t.Cleanup(h.presenceCallbacks.shutdown)
	c := &Client{hub: h, userID: "host", connectionID: 1}
	h.clients["host"] = map[*Client]bool{c: true}
	seen := make(chan string, 2)
	h.OnGameActivityUpdate(func(_ string, _ uint64, _ uint64, game *GameActivityClientGame) { seen <- game.Name })
	game := map[string]any{"id": "11111111-1111-4111-8111-111111111111", "name": "injected"}
	c.handleGameActivityUpdate(Event{Data: map[string]any{"game": game, "transition": true}})
	c.handleGameActivityUpdate(Event{Data: GameActivityClientUpdate{Game: &GameActivityClientGame{ID: "11111111-1111-4111-8111-111111111111", Name: "valid"}}})
	select {
	case name := <-seen:
		if name != "valid" {
			t.Fatal("client forged server-only transition", name)
		}
	case <-time.After(time.Second):
		t.Fatal("valid update was not processed")
	}
}
