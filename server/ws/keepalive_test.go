package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ─── deliver() × done channel (hub_broadcast.go) ───

// TestDeliverDropsForRemovedClientWithoutRequeue: after removeClient closes
// done, deliver must drop silently instead of hitting the full-buffer default
// branch — which would re-queueUnregister an already-removed client on every
// subsequent broadcast until the maps drained.
func TestDeliverDropsForRemovedClientWithoutRequeue(t *testing.T) {
	h := NewHub()
	// Unbuffered send: the send case can never proceed, so the select decides
	// purely between <-done (fixed behavior) and default (old behavior).
	c := &Client{hub: h, userID: "u1", send: make(chan []byte), done: make(chan struct{})}
	h.addClient(c)
	h.removeClient(c) // closes done

	before := len(h.unregister)
	h.deliver(c, OpMessageCreate, []byte("{}"))
	if got := len(h.unregister); got != before {
		t.Fatalf("deliver re-queued an already-removed client (unregister %d -> %d)", before, got)
	}
}

// TestDeliverFullBufferStillQueuesUnregister: the slow-client protection must
// survive the done-case addition — a LIVE client with a full buffer still gets
// queued for unregistration.
func TestDeliverFullBufferStillQueuesUnregister(t *testing.T) {
	h := NewHub()
	c := &Client{hub: h, userID: "u1", send: make(chan []byte), done: make(chan struct{})}
	h.addClient(c)

	before := len(h.unregister)
	h.deliver(c, OpMessageCreate, []byte("{}"))
	if got := len(h.unregister); got != before+1 {
		t.Fatalf("full-buffer deliver must queue unregister (%d -> %d)", before, got)
	}
}

// ─── protocol ping/pong keepalive (client.go) ───

// dialTestClient upgrades one real WebSocket pair: the server side gets a
// Client with running Read/Write pumps registered on h, the test keeps the
// dialer side. pongWait/pingPeriod are package VARS precisely so this test
// can shrink multi-second timing into milliseconds.
func dialTestClient(t *testing.T, h *Hub) (*websocket.Conn, *Client) {
	t.Helper()

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	connCh := make(chan *Client, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		c := &Client{hub: h, conn: conn, userID: "u1", send: make(chan []byte, 8), done: make(chan struct{})}
		h.addClient(c)
		go c.WritePump()
		go c.ReadPump()
		connCh <- c
	}))
	t.Cleanup(srv.Close)

	peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })

	var c *Client
	select {
	case c = <-connCh:
	case <-time.After(2 * time.Second):
		t.Fatal("server never produced a client")
	}

	// Registered LAST so it runs FIRST (LIFO) — before withShortKeepalive's
	// cleanup restores pongWait/pingPeriod. ReadPump's pong handler reads
	// those vars; restoring them while the pumps still run is a data race
	// under -race. Closing the peer errors ReadPump out, and done closes
	// once hub.Run processes the unregister.
	t.Cleanup(func() {
		_ = peer.Close()
		select {
		case <-c.done:
		case <-time.After(3 * time.Second):
			t.Log("keepalive test client never unregistered — vars restore may race")
		}
	})

	return peer, c
}

func withShortKeepalive(t *testing.T, pong, ping time.Duration) {
	t.Helper()
	oldPong, oldPing := pongWait, pingPeriod
	pongWait, pingPeriod = pong, ping
	t.Cleanup(func() { pongWait, pingPeriod = oldPong, oldPing })
}

// TestKeepalive_IdleConnectionSurvivesViaPings: an idle-but-healthy peer
// (like a throttled background tab that misses app heartbeats but whose
// network stack still answers protocol pings — gorilla's default ping
// handler pongs, same as browsers) must stay connected well past pongWait.
func TestKeepalive_IdleConnectionSurvivesViaPings(t *testing.T) {
	withShortKeepalive(t, 500*time.Millisecond, 150*time.Millisecond)

	h := NewHub()
	go h.Run()

	peer, c := dialTestClient(t, h)

	// The dialer must keep reading for its default ping→pong handler to run.
	go func() {
		for {
			if _, _, err := peer.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Idle for 3× pongWait. Without the ping ticker the read deadline would
	// have expired and ReadPump would have unregistered the client.
	time.Sleep(3 * pongWait)

	select {
	case <-c.done:
		t.Fatal("idle connection was dropped despite protocol pings")
	default:
	}
}

// TestKeepalive_DeadPeerIsDetected: a peer that swallows pings without
// ponging (half-open connection stand-in) must be torn down once the read
// deadline lapses — instead of lingering while broadcasts pile into its
// send buffer.
func TestKeepalive_DeadPeerIsDetected(t *testing.T) {
	withShortKeepalive(t, 400*time.Millisecond, 100*time.Millisecond)

	h := NewHub()
	go h.Run()

	peer, c := dialTestClient(t, h)

	// Swallow pings: no pong ever goes back, so the server's read deadline
	// is never refreshed.
	peer.SetPingHandler(func(string) error { return nil })
	go func() {
		for {
			if _, _, err := peer.ReadMessage(); err != nil {
				return
			}
		}
	}()

	deadline := time.After(5 * pongWait)
	for {
		select {
		case <-c.done:
			return // detected and removed — the fix works
		case <-deadline:
			t.Fatal("silent peer was never disconnected (dead socket lingered)")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
