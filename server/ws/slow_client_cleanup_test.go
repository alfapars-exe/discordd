package ws

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Inject a stalled network write after the HTTP upgrade. The write still honors
// its deadline, but closing the transport must release it immediately.
type stalledWSConn struct {
	net.Conn
	stall     atomic.Bool
	deadline  atomic.Int64
	started   chan struct{}
	closed    chan struct{}
	startOnce sync.Once
	closeOnce sync.Once
}

func (c *stalledWSConn) SetWriteDeadline(deadline time.Time) error {
	c.deadline.Store(deadline.UnixNano())
	return c.Conn.SetWriteDeadline(deadline)
}
func (c *stalledWSConn) Write(data []byte) (int, error) {
	if !c.stall.Load() {
		return c.Conn.Write(data)
	}
	c.startOnce.Do(func() { close(c.started) })
	timer := time.NewTimer(time.Until(time.Unix(0, c.deadline.Load())))
	defer timer.Stop()
	select {
	case <-c.closed:
		return 0, net.ErrClosed
	case <-timer.C:
		return 0, os.ErrDeadlineExceeded
	}
}
func (c *stalledWSConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

type stalledWSWriter struct {
	http.ResponseWriter
	conn *stalledWSConn
}

func (w *stalledWSWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	w.conn = &stalledWSConn{Conn: conn, started: make(chan struct{}), closed: make(chan struct{})}
	return w.conn, buffer, nil
}

func TestRemovedClientDoesNotWaitOnSaturatedUnregisterQueue(t *testing.T) {
	hub := NewHub()
	defer hub.Shutdown()
	client := &Client{hub: hub, userID: "removed", done: make(chan struct{})}
	hub.addClient(client)
	hub.removeClient(client)
	for n := 0; n < cap(hub.unregister); n++ {
		hub.unregister <- &Client{}
	}
	finished := make(chan struct{})
	go func() { hub.unregisterClient(client); close(finished) }()
	defer func() {
		select {
		case <-finished:
		default:
			<-hub.unregister
			<-finished
		}
	}()
	select {
	case <-finished:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("removed read pump still blocked on the full unregister queue")
	}
}

func TestRemovingStalledSocketReleasesBothPumps(t *testing.T) {
	hub := NewHub()
	defer hub.Shutdown()
	type fixture struct {
		client              *Client
		transport           *stalledWSConn
		readDone, writeDone chan struct{}
	}
	var livePumps atomic.Int32
	created := make(chan fixture, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrapped := &stalledWSWriter{ResponseWriter: w}
		conn, err := upgrader.Upgrade(wrapped, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		wrapped.conn.stall.Store(true)
		client := &Client{hub: hub, conn: conn, userID: "stalled", serverIDs: []string{"shared"}, send: make(chan []byte, 8), done: make(chan struct{})}
		hub.addClient(client)
		f := fixture{client: client, transport: wrapped.conn, readDone: make(chan struct{}), writeDone: make(chan struct{})}
		livePumps.Add(2)
		go func() { defer close(f.readDone); defer livePumps.Add(-1); client.ReadPump() }()
		go func() { defer close(f.writeDone); defer livePumps.Add(-1); client.WritePump() }()
		created <- f
	}))
	defer server.Close()
	waves := 8
	if os.Getenv("HICHAT_MEASURE_WS_SLOW_CHURN") == "1" {
		waves = 256
	}
	for wave := 1; wave <= waves; wave++ {
		func() {
			peer, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			var f fixture
			select {
			case f = <-created:
			case <-time.After(time.Second):
				t.Fatal("client fixture was not created")
			}
			defer func() { _ = peer.Close(); _ = f.transport.Close(); <-f.readDone; <-f.writeDone }()
			f.client.send <- []byte(`{"op":"fixture"}`)
			select {
			case <-f.transport.started:
			case <-time.After(time.Second):
				t.Fatal("write never reached the injected backpressure")
			}
			hub.removeClient(f.client)
			deadline := time.NewTimer(500 * time.Millisecond)
			defer deadline.Stop()
			for _, done := range []chan struct{}{f.readDone, f.writeDone} {
				select {
				case <-done:
				case <-deadline.C:
					t.Fatal("removed socket retained a read/write pump until its network deadline")
				}
			}
			if len(hub.GetOnlineUserIDs()) != 0 || len(hub.GetOnlineUserIDsForServer("shared")) != 0 {
				t.Fatal("removed socket retained membership")
			}
			if livePumps.Load() != 0 {
				t.Fatal("removed socket retained active pumps")
			}
		}()
		if waves == 256 && (wave == 16 || wave == waves) {
			runtime.GC()
			runtime.GC()
			var stats runtime.MemStats
			runtime.ReadMemStats(&stats)
			t.Logf("waves=%d live_pumps=%d heap_bytes=%d goroutines=%d", wave, livePumps.Load(), stats.HeapAlloc, runtime.NumGoroutine())
		}
	}
	runtime.KeepAlive(hub)
	runtime.KeepAlive(server)
}
