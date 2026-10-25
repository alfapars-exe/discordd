package ws

import (
	"testing"
	"time"
)

// A registration acknowledgement gates ready and both websocket pumps.
// Every callback must be submitted in the same order its ticket was reserved.
func TestRegistrationAcknowledgesWithPresenceAndGameActivityCallbacks(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "first_connection"
		if existing {
			name = "additional_connection"
		}
		t.Run(name, func(t *testing.T) {
			h := NewHub()
			if existing {
				h.addClient(presenceClient(h, "ready-user", "online"))
			}
			order := make(chan string, 2)
			h.onUserFirstConnect = func(_, _ string) { order <- "presence" }
			h.onPresenceManualUpdate = func(_, _ string, _ bool) { order <- "presence" }
			h.onGameActivityConnect = func(_ string, _ uint64) { order <- "game" }
			client := presenceClient(h, "ready-user", "online")
			client.registered = make(chan struct{})
			finished := make(chan struct{})
			t.Cleanup(func() {
				h.presenceCallbacks.shutdown()
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Error("registration goroutine did not stop during cleanup")
				}
			})
			go func() { h.addClient(client); close(finished) }()
			select {
			case <-client.registered:
			case <-time.After(time.Second):
				t.Fatal("registration acknowledgement blocked before ready")
			}
			for _, expected := range []string{"presence", "game"} {
				select {
				case actual := <-order:
					if actual != expected {
						t.Fatalf("callback = %q, want %q", actual, expected)
					}
				case <-time.After(time.Second):
					t.Fatalf("callback %q did not run", expected)
				}
			}
		})
	}
}

func TestRemovalCompletesWithPresenceAndGameActivityCallbacks(t *testing.T) {
	for _, remaining := range []bool{false, true} {
		name := "last_connection"
		if remaining {
			name = "partial_disconnect"
		}
		t.Run(name, func(t *testing.T) {
			h := NewHub()
			client := presenceClient(h, "ready-user", "online")
			h.addClient(client)
			if remaining {
				h.addClient(presenceClient(h, "ready-user", "online"))
			}
			order := make(chan string, 2)
			h.onUserFullyDisconnected = func(_, _ string) { order <- "presence" }
			h.onPresenceManualUpdate = func(_, _ string, _ bool) { order <- "presence" }
			h.onGameActivityDisconnect = func(_ string, _ uint64) { order <- "game" }
			finished := make(chan struct{})
			t.Cleanup(func() {
				h.presenceCallbacks.shutdown()
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Error("removal goroutine did not stop during cleanup")
				}
			})
			go func() { h.removeClient(client); close(finished) }()
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("removal blocked the hub before future registrations")
			}
			for _, expected := range []string{"presence", "game"} {
				select {
				case actual := <-order:
					if actual != expected {
						t.Fatalf("callback = %q, want %q", actual, expected)
					}
				case <-time.After(time.Second):
					t.Fatalf("callback %q did not run", expected)
				}
			}
		})
	}
}
