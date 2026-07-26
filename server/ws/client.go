package ws

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	maxMessageSize = 32768 // 32KB — WebRTC SDP + E2EE base64 overhead
	sendBufferSize = 256
)

// pongWait/pingPeriod are package vars (not consts) so integration tests can
// shorten them to exercise the keepalive path without multi-second sleeps.
var (
	pongWait = 90 * time.Second // 3 missed heartbeats (30s × 3)

	// pingPeriod drives the protocol-level ping ticker in WritePump. Must be
	// comfortably < pongWait so a healthy peer always gets a deadline refresh
	// in time. Protocol pings matter beyond the app-level heartbeat op:
	// browsers answer them in the network stack even when JS timers are
	// throttled (backgrounded tab), so idle-but-healthy tabs stay connected —
	// and a dead TCP peer fails the ping write within writeWait, surfacing
	// the dead socket in ~pingPeriod+writeWait instead of the full pongWait.
	pingPeriod = 30 * time.Second
)

// dispatchLogger tags every per-connection event-handling log line
// ("ws.dispatch"). Shared package-level var — also used from
// client_dispatch.go, client_p2p.go, client_presence.go, client_voice.go.
var dispatchLogger = logx.Component("ws.dispatch")

// Client represents a single WebSocket connection.
// Each connection runs two goroutines: ReadPump (read) and WritePump (write).
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID string
	send   chan []byte
	mu     sync.Mutex // protects conn.WriteMessage

	// done is closed exactly once (via closeDone) when the Hub removes this
	// client — from removeClient (ban / disconnect) or Shutdown. The send
	// channel is deliberately NEVER closed: sendEvent (below) and deliver
	// (hub_broadcast.go) write to send from goroutines that don't hold h.mu,
	// so closing send would race those writes into a "send on closed channel"
	// panic that kills the whole process. Closing a separate done channel
	// instead lets every sender select on <-c.done and lets WritePump exit,
	// making send-on-closed structurally impossible.
	done      chan struct{}
	closeOnce sync.Once

	// serverIDs: servers this user belongs to. Populated from DB at connect,
	// updated on join/leave. Used by BroadcastToServer for filtering.
	serverIDs []string

	// prefStatus: user's preferred presence loaded from DB at connect time.
	// Used by addClient to set initial per-connection status.
	prefStatus string

	// status: per-connection presence. Hub aggregates across all connections
	// to determine the user's visible status (highest priority wins).
	// Accessed under Hub.mu.
	status string

	// rateLimit guards inbound events from a single connection so a
	// misbehaving (or hostile) client cannot amplify hub broadcasts by
	// spraying typing/voice-activity events. See rate_limit.go for per-op
	// caps. Lazily initialized on first event in handleEvent so existing
	// addClient paths don't need to know about it.
	rateLimit *clientRateLimiter

	// isBot restricts this connection to BotReadableOps (see hub.deliver).
	// Bot connections are read-only consumers; they act via the REST API.
	isBot bool
}

// ReadPump reads messages from the WebSocket and dispatches events.
// Runs until the connection closes, then unregisters from Hub.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)

	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		dispatchLogger.Error("failed to set read deadline", "user_id", c.userID, "err", pkg.ErrText(err))
		return
	}

	// Protocol pong (reply to WritePump's ping) refreshes the read deadline.
	// The app-level heartbeat op does the same (client_dispatch.go) — belt
	// and braces: throttled background tabs miss heartbeats but still pong.
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, rawMessage, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				c.logUnexpectedClose(err)
			}
			return
		}

		var event Event
		if err := json.Unmarshal(rawMessage, &event); err != nil {
			dispatchLogger.Warn("invalid message from client", "user_id", c.userID, "err", pkg.ErrText(err))
			continue
		}

		c.handleEvent(event)
	}
}

// logUnexpectedClose classifies and logs a WebSocket close that ReadPump
// determined wasn't a graceful going-away/normal-closure. Split out of
// ReadPump to keep its branching shallow — behavior is unchanged.
func (c *Client) logUnexpectedClose(err error) {
	// Branch on close code: 1006 (abnormal — no graceful close frame,
	// usually a crashed renderer or a yanked cable), 1011 (server internal
	// error reflected back), and 1012 (service restart) are genuine
	// anomalies and stay at WARN. Everything else (mobile background, OS
	// sleep wake-up, router NAT timeout) is logged at INFO so the WARN feed
	// reflects things worth investigating instead of normal session churn.
	level := models.LogLevelInfo
	if websocket.IsCloseError(err,
		websocket.CloseAbnormalClosure,
		websocket.CloseInternalServerErr,
		websocket.CloseServiceRestart) {
		level = models.LogLevelWarn
	}
	if level == models.LogLevelWarn {
		dispatchLogger.Warn("unexpected websocket close", "user_id", c.userID, "err", pkg.ErrText(err))
	} else {
		dispatchLogger.Info("unexpected websocket close", "user_id", c.userID, "err", pkg.ErrText(err))
	}
	c.hub.logEvent(level, models.LogCategoryWS, &c.userID,
		"WebSocket unexpected close", map[string]string{"error": err.Error()})
}

// closeDone signals sender goroutines and WritePump that the Hub has removed
// this client. Idempotent — safe to call from both removeClient and Shutdown
// (h.mu already serializes them, but the Once makes single-close local and
// self-evident rather than an invariant a future edit could break).
func (c *Client) closeDone() {
	c.closeOnce.Do(func() { close(c.done) })
}

func (c *Client) sendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		dispatchLogger.Error("failed to marshal event", "user_id", c.userID, "err", pkg.ErrText(err))
		return
	}

	select {
	case c.send <- data:
	case <-c.done:
		// Client already removed (ban / disconnect / shutdown). Drop silently —
		// WritePump has exited and nothing will drain send.
	default:
		dispatchLogger.Warn("send buffer full, dropping connection", "user_id", c.userID)
		// Non-blocking enqueue — see Hub.queueUnregister rationale. We're
		// already on the client goroutine here so we don't strictly need
		// to avoid blocking, but keeping the discipline uniform across
		// all unregister paths prevents subtle deadlocks.
		c.hub.queueUnregister(c)
	}
}

// WritePump writes messages from Hub to the WebSocket connection.
// Runs as a goroutine until the Hub closes this client's done channel.
func (c *Client) WritePump() {
	defer c.conn.Close()

	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case message := <-c.send:
			if err := c.writeMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			// Protocol keepalive — see the pingPeriod comment. A failed ping
			// write means the peer is unreachable; exit and let ReadPump's
			// deadline/close path unregister the client.
			if err := c.writeMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			// Hub removed this client (removeClient / Shutdown closed done).
			// Flush anything still buffered in send — mirrors the old
			// close(send) behavior where <-c.send drained the buffer before
			// reporting the channel closed — then send the courtesy close
			// frame. The peer may already be gone, so a write error is moot.
			for {
				select {
				case message := <-c.send:
					if err := c.writeMessage(websocket.TextMessage, message); err != nil {
						return
					}
				default:
					_ = c.writeMessage(websocket.CloseMessage, nil)
					return
				}
			}
		}
	}
}

// writeMessage writes to the WebSocket connection under mutex.
// gorilla/websocket does not support concurrent writes.
func (c *Client) writeMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}
	return c.conn.WriteMessage(messageType, data)
}
