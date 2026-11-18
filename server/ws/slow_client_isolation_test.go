package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type backpressurePeer struct {
	peer                *websocket.Conn
	client              *Client
	transport           *stalledWSConn
	readDone, writeDone chan struct{}
}

func connectBackpressurePeer(t *testing.T, hub *Hub, user string, stalled bool) backpressurePeer {
	t.Helper()
	created := make(chan backpressurePeer, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrapped := &stalledWSWriter{ResponseWriter: w}
		conn, err := upgrader.Upgrade(wrapped, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		wrapped.conn.stall.Store(stalled)
		client := &Client{hub: hub, conn: conn, userID: user, send: make(chan []byte, sendBufferSize), done: make(chan struct{})}
		hub.addClient(client)
		f := backpressurePeer{client: client, transport: wrapped.conn, readDone: make(chan struct{}), writeDone: make(chan struct{})}
		go func() { defer close(f.readDone); client.ReadPump() }()
		go func() { defer close(f.writeDone); client.WritePump() }()
		created <- f
	}))
	t.Cleanup(server.Close)
	peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	var f backpressurePeer
	select {
	case f = <-created:
	case <-time.After(2 * time.Second):
		t.Fatal("upgraded client was not registered")
	}
	f.peer = peer
	t.Cleanup(func() {
		_ = peer.Close()
		_ = f.client.conn.Close()
		awaitBackpressurePumps(t, f)
	})
	return f
}

func awaitBackpressurePumps(t *testing.T, f backpressurePeer) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for _, done := range []chan struct{}{f.readDone, f.writeDone} {
		select {
		case <-done:
		case <-deadline.C:
			t.Fatal("backpressured socket retained a read/write pump")
		}
	}
}

func (f backpressurePeer) receiveSequence(t *testing.T, sequence int) {
	t.Helper()
	if err := f.peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var received struct {
		Op   string                  `json:"op"`
		Data struct{ Sequence *int } `json:"d"`
	}
	if err := f.peer.ReadJSON(&received); err != nil {
		t.Fatal(err)
	}
	if received.Op != OpMessageCreate || received.Data.Sequence == nil || *received.Data.Sequence != sequence {
		t.Fatalf("healthy frame=%+v, want message_create sequence %d", received, sequence)
	}
}

func TestSlowConsumerOverflowDoesNotInterruptHealthySocket(t *testing.T) {
	hub := NewHub()
	hubDone := make(chan struct{})
	go func() { defer close(hubDone); hub.Run() }()
	t.Cleanup(func() { hub.Shutdown(); <-hubDone })
	slow := connectBackpressurePeer(t, hub, "slow", true)
	healthy := connectBackpressurePeer(t, hub, "healthy", false)
	// One blocked write, a full production-size queue, then the overflow
	// must retire only the slow peer through Hub.Run, without manual removal.
	hub.BroadcastToAll(Event{Op: OpMessageCreate, Data: map[string]int{"sequence": 0}})
	healthy.receiveSequence(t, 0)
	select {
	case <-slow.transport.started:
	case <-time.After(time.Second):
		t.Fatal("slow peer did not reach the blocked write")
	}
	for sequence := 1; sequence < sendBufferSize+3; sequence++ {
		hub.BroadcastToAll(Event{Op: OpMessageCreate, Data: map[string]int{"sequence": sequence}})
		healthy.receiveSequence(t, sequence)
	}
	awaitBackpressurePumps(t, slow)
	users := hub.GetOnlineUserIDs()
	if len(users) != 1 || users[0] != "healthy" {
		t.Fatalf("overflow removed the wrong clients: %v", users)
	}
}
