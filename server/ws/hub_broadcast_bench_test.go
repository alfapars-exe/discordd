// Benchmarks for the BroadcastToServer hot path.
//
// BroadcastToServer_SlowClients is the regression guard for a production
// incident: hub_broadcast.go used to unregister a slow client with
// `go func() { h.unregister <- c }()` — one goroutine spawned per slow
// client PER BROADCAST. Under a thundering-herd disconnect (server-wide
// announcement right after a network blip, so every client's send buffer is
// already full) that fanned out unboundedly and never got cleaned up until
// each blocked goroutine finally got a slot on h.unregister. The fix
// (hub_broadcast.go: deliver -> queueUnregister) replaced the goroutine with
// a non-blocking channel send. This file benchmarks the fixed path and
// fails loudly if the goroutine-per-slow-client pattern is ever reintroduced.
package ws

import (
	"fmt"
	"runtime"
	"testing"
)

// benchServerHub builds a Hub with n distinct-user Clients, each a member of
// the single returned server ID, registered directly via addClient (mirrors
// hub_state_test.go's construction style — no h.Run() goroutine, so nothing
// but the benchmark's own timed loop runs against the hub).
//
// Slow clients start with full queues. Healthy clients are drained between
// timed batches so a scheduler delay cannot switch the measured delivery path.
func benchServerHub(b *testing.B, n int, slow bool) (*Hub, string, []*Client) {
	b.Helper()

	h := NewHub()
	const sid = "bench-server"

	clients := make([]*Client, 0, n)
	for i := 0; i < n; i++ {
		c := &Client{
			hub:       h,
			userID:    fmt.Sprintf("bench-user-%d", i),
			send:      make(chan []byte, sendBufferSize),
			done:      make(chan struct{}),
			serverIDs: []string{sid},
		}
		h.addClient(c)
		clients = append(clients, c)
	}

	if slow {
		filler := []byte(`{"op":"filler"}`)
		for _, c := range clients {
			for i := 0; i < cap(c.send); i++ {
				c.send <- filler
			}
		}
	}
	return h, sid, clients
}

// Measure only the deliveries. Draining exactly one entry per delivery also
// verifies that every healthy client received the full batch.
func benchHealthyDeliveries(b *testing.B, clients []*Client, deliver func()) {
	b.Helper()
	b.ResetTimer()
	for remaining := b.N; remaining > 0; {
		batch := min(remaining, cap(clients[0].send))
		for range batch {
			deliver()
		}
		b.StopTimer()
		for _, client := range clients {
			if got := len(client.send); got != batch {
				b.Fatalf("client %s received %d of %d deliveries", client.userID, got, batch)
			}
			for range batch {
				<-client.send
			}
		}
		remaining -= batch
		if remaining > 0 {
			b.StartTimer()
		}
	}
}

// BenchmarkBroadcastToServer_FastClients measures steady-state throughput:
// every client's queue has room for the entire batch, so
// deliver always takes the fast `client.send <- data` path.
func BenchmarkBroadcastToServer_FastClients(b *testing.B) {
	for _, n := range []int{10, 100, 1000} {
		b.Run(fmt.Sprintf("clients=%d", n), func(b *testing.B) {
			h, sid, clients := benchServerHub(b, n, false)

			event := Event{Op: OpMessageCreate, Data: map[string]string{"content": "bench message"}}

			benchHealthyDeliveries(b, clients, func() { h.BroadcastToServer(sid, event) })
		})
	}
}

// BenchmarkBroadcastToServer_SlowClients is the thundering-herd regression
// guard. Every client's send buffer is already full (see benchServerHub), so
// every deliver() call falls through to queueUnregister. The fixed
// implementation enqueues onto the buffered h.unregister channel (or drops,
// select-default, if that buffer is also full) without ever spawning a
// goroutine, so runtime.NumGoroutine() should stay essentially flat across
// the whole timed loop. The old `go func() { h.unregister <- c }()` pattern
// would instead grow goroutine count by roughly b.N * n (minus whatever
// h.Run() — not started here — would have drained), which this assertion
// catches well before that.
func BenchmarkBroadcastToServer_SlowClients(b *testing.B) {
	for _, n := range []int{10, 100, 1000} {
		b.Run(fmt.Sprintf("clients=%d", n), func(b *testing.B) {
			h, sid, _ := benchServerHub(b, n, true)

			event := Event{Op: OpMessageCreate, Data: map[string]string{"content": "bench message"}}

			base := runtime.NumGoroutine()

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.BroadcastToServer(sid, event)
			}
			b.StopTimer()

			if got := runtime.NumGoroutine(); got-base > 100 {
				b.Fatalf("thundering-herd goroutine leak: +%d goroutines", got-base)
			}
		})
	}
}

// BenchmarkDeliver micro-benchmarks the single per-client delivery
// chokepoint in isolation (bot filter check + channel send), with one
// human client with available queue capacity so every call takes the fast path.
func BenchmarkDeliver(b *testing.B) {
	h := NewHub()
	c := &Client{hub: h, userID: "bench-single", send: make(chan []byte, sendBufferSize), done: make(chan struct{})}

	data := []byte(`{"op":"message_create"}`)
	benchHealthyDeliveries(b, []*Client{c}, func() { h.deliver(c, OpMessageCreate, data) })
}
