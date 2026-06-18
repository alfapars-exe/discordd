package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 90 * time.Second // 3 missed heartbeats (30s × 3)
	maxMessageSize = 32768            // 32KB — WebRTC SDP + E2EE base64 overhead
	sendBufferSize = 256
)

// Client represents a single WebSocket connection.
// Each connection runs two goroutines: ReadPump (read) and WritePump (write).
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID string
	send   chan []byte
	mu     sync.Mutex // protects conn.WriteMessage

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
		log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
		return
	}

	for {
		_, rawMessage, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				// Branch on close code: 1006 (abnormal — no graceful close
				// frame, usually a crashed renderer or a yanked cable),
				// 1011 (server internal error reflected back), and 1012
				// (service restart) are genuine anomalies and stay at WARN.
				// Everything else (mobile background, OS sleep wake-up,
				// router NAT timeout) is logged at INFO so the WARN feed
				// reflects things worth investigating instead of normal
				// session churn.
				log.Printf("[ws] unexpected close for user %s: %v", c.userID, err)
				level := models.LogLevelInfo
				if websocket.IsCloseError(err,
					websocket.CloseAbnormalClosure,
					websocket.CloseInternalServerErr,
					websocket.CloseServiceRestart) {
					level = models.LogLevelWarn
				}
				c.hub.logEvent(level, models.LogCategoryWS, &c.userID,
					"WebSocket unexpected close", map[string]string{"error": err.Error()})
			}
			return
		}

		var event Event
		if err := json.Unmarshal(rawMessage, &event); err != nil {
			log.Printf("[ws] invalid message from user %s: %v", c.userID, err)
			continue
		}

		c.handleEvent(event)
	}
}

func (c *Client) sendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[ws] failed to marshal event for user %s: %v", c.userID, err)
		return
	}

	select {
	case c.send <- data:
	default:
		log.Printf("[ws] send buffer full for user %s, dropping connection", c.userID)
		// Non-blocking enqueue — see Hub.queueUnregister rationale. We're
		// already on the client goroutine here so we don't strictly need
		// to avoid blocking, but keeping the discipline uniform across
		// all unregister paths prevents subtle deadlocks.
		c.hub.queueUnregister(c)
	}
}

// WritePump writes messages from Hub to the WebSocket connection.
// Runs as a goroutine until the send channel is closed.
func (c *Client) WritePump() {
	defer c.conn.Close()

	for {
		message, ok := <-c.send
		if !ok {
			// Channel closed — Hub removed this client. The close frame is a
			// courtesy; the peer may already be gone, so the error is moot.
			_ = c.writeMessage(websocket.CloseMessage, nil)
			return
		}

		if err := c.writeMessage(websocket.TextMessage, message); err != nil {
			return
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
