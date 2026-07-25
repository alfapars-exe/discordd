package ws

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// TestSendEventNoPanicOnConcurrentRemove verifies that Client.sendEvent never
// writes to a closed send channel while the Hub concurrently removes the
// client (ban / forced disconnect).
//
// Before the done-channel fix, removeClient closed client.send under h.mu
// (hub_clients.go) while sendEvent wrote to it lock-free (client.go). h.mu did
// not cover the sendEvent write, so a send racing a removeClient panicked with
// "send on closed channel" and — since sendEvent runs on the HandleConnection
// and ReadPump goroutines, outside deliver's RLock — took the whole process
// down (one connection loss = every user dropped).
//
// The recover() below counts panics instead of aborting the test binary, so
// this is red on the old code and green on the fixed code. Run under -race in
// CI (server-ci.yml already passes -race).
func TestSendEventNoPanicOnConcurrentRemove(t *testing.T) {
	const clients = 300

	h := NewHub()

	var panics int32
	var wg sync.WaitGroup

	// start barrier: release all writer/remover pairs at once so the send and
	// the close collide in the tightest possible window.
	start := make(chan struct{})

	for i := 0; i < clients; i++ {
		c := &Client{
			hub:    h,
			userID: fmt.Sprintf("u%d", i),
			send:   make(chan []byte, 1), // tiny buffer → sends contend with close
			done:   make(chan struct{}),
		}
		h.addClient(c)

		wg.Add(2)

		go func(c *Client) {
			defer wg.Done()
			<-start
			for j := 0; j < 50; j++ {
				func() {
					defer func() {
						if r := recover(); r != nil {
							atomic.AddInt32(&panics, 1)
						}
					}()
					c.sendEvent(Event{Op: OpHeartbeatAck})
				}()
			}
		}(c)

		go func(c *Client) {
			defer wg.Done()
			<-start
			h.removeClient(c)
		}(c)
	}

	close(start)
	wg.Wait()

	if panics > 0 {
		t.Fatalf("sendEvent panicked %d time(s) racing removeClient (send on closed channel)", panics)
	}
}

// TestShutdownConcurrentSendNoPanic exercises the other closer: Hub.Shutdown
// closes every client's send path (hub.go) while sendEvent is in flight.
func TestShutdownConcurrentSendNoPanic(t *testing.T) {
	const clients = 300

	h := NewHub()

	var panics int32
	var wg sync.WaitGroup
	start := make(chan struct{})

	cs := make([]*Client, 0, clients)
	for i := 0; i < clients; i++ {
		c := &Client{
			hub:    h,
			userID: fmt.Sprintf("u%d", i),
			send:   make(chan []byte, 1),
			done:   make(chan struct{}),
		}
		h.addClient(c)
		cs = append(cs, c)

		wg.Add(1)
		go func(c *Client) {
			defer wg.Done()
			<-start
			for j := 0; j < 50; j++ {
				func() {
					defer func() {
						if r := recover(); r != nil {
							atomic.AddInt32(&panics, 1)
						}
					}()
					c.sendEvent(Event{Op: OpHeartbeatAck})
				}()
			}
		}(c)
	}

	// Shutdown calls conn.Close(); these test clients have a nil conn, so drive
	// only the send-close half (phase 1) here — that is the half that races
	// sendEvent. Phase 2 (conn.Close) is covered by integration paths.
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		h.mu.Lock()
		list := make([]*Client, 0, len(cs))
		for _, clients := range h.clients {
			for c := range clients {
				list = append(list, c)
			}
		}
		h.clients = make(map[string]map[*Client]bool)
		h.serverClients = make(map[string]map[*Client]bool)
		h.mu.Unlock()
		for _, c := range list {
			c.closeDone()
		}
	}()

	close(start)
	wg.Wait()

	if panics > 0 {
		t.Fatalf("sendEvent panicked %d time(s) racing shutdown send-close", panics)
	}
}
