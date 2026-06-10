// Client event dispatch: op-code handler registry, rate limiting, and panic recovery.
package ws

import (
	"fmt"
	"log"
	"runtime/debug"
	"time"

	"github.com/argeinfina/hichat/models"
)

// eventHandlers maps WS operation codes to client handler functions.
// Populated once in init() — read-only after startup, no concurrency concern.
// To add a new event type, add a method on *Client and register it here.
var eventHandlers map[string]func(c *Client, event Event)

func init() {
	eventHandlers = map[string]func(c *Client, event Event){
		OpHeartbeat:             (*Client).handleHeartbeat,
		OpTyping:                (*Client).handleTyping,
		OpPresenceUpdate:        (*Client).handlePresenceUpdate,
		OpVoiceJoin:             (*Client).handleVoiceJoin,
		OpVoiceLeave:            func(c *Client, _ Event) { c.handleVoiceLeave() },
		OpVoiceStateUpdateReq:   (*Client).handleVoiceStateUpdate,
		OpVoiceAdminStateUpdate: (*Client).handleVoiceAdminStateUpdate,
		OpVoiceMoveUser:         (*Client).handleVoiceMoveUser,
		OpVoiceDisconnectUser:   (*Client).handleVoiceDisconnectUser,
		OpScreenShareWatch:      (*Client).handleScreenShareWatch,
		OpVoiceActivity:         func(c *Client, _ Event) { c.handleVoiceActivity() },
		OpDMTypingStart:         (*Client).handleDMTyping,
		OpP2PCallInitiate:       (*Client).handleP2PCallInitiate,
		OpP2PCallAccept:         (*Client).handleP2PCallAccept,
		OpP2PCallDecline:        (*Client).handleP2PCallDecline,
		OpP2PCallEnd:            func(c *Client, _ Event) { c.handleP2PCallEnd() },
		OpP2PSignal:             (*Client).handleP2PSignal,
	}
}

// handleEvent dispatches an incoming event to its registered handler.
//
// Inbound events are rate-limited per (client, op) before dispatch. A
// dropped event is silently discarded with a warning log — never close
// the connection, which would only force a reconnect storm and make the
// DoS pressure worse.
//
// Panic recovery (audit 2026-05-27): a panic in any handler is recovered,
// logged with a full stack trace, and written as a critical audit event so
// operators can alert on it. The misbehaving connection is closed to
// prevent further panic-inducing payloads on the same socket; the client
// will reconnect and the panicking handler can be fixed without taking
// down the rest of the hub. Choice rationale: closing one connection has
// far smaller blast radius than crashing the whole goroutine (which
// previously orphaned the connection and could cascade to the hub).
func (c *Client) handleEvent(event Event) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		stack := debug.Stack()
		log.Printf("[ws] PANIC in handler user=%s op=%s recovered=%v\n%s",
			c.userID, event.Op, r, stack)
		c.hub.logEvent(
			models.LogLevelError, models.LogCategoryWS, &c.userID,
			fmt.Sprintf("WS handler panic recovered (op=%s)", event.Op),
			map[string]string{
				"op":     event.Op,
				"panic":  fmt.Sprintf("%v", r),
				"stack":  string(stack),
				"action": "connection_closed",
			},
		)
		// Close the misbehaving connection — client will reconnect with a
		// fresh state and a future event won't immediately re-trigger the
		// same panic on the same socket buffer.
		c.hub.queueUnregister(c)
	}()

	if c.rateLimit == nil {
		c.rateLimit = newClientRateLimiter()
	}
	if !c.rateLimit.allow(event.Op) {
		// Rate-limit drops are common enough during typing storms that
		// logging every one would flood the log. Only log every Nth or
		// at a sampled rate in production — for now we keep it visible
		// while the limits are being tuned.
		log.Printf("[ws] RATE LIMIT user=%s op=%s (event dropped)", c.userID, event.Op)
		return
	}

	if handler, ok := eventHandlers[event.Op]; ok {
		handler(c, event)
		return
	}
	log.Printf("[ws] unknown op from user %s: %s", c.userID, event.Op)
}

// handleHeartbeat resets the read deadline and acks the client's heartbeat.
func (c *Client) handleHeartbeat(_ Event) {
	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Printf("[ws] failed to set read deadline for user %s: %v", c.userID, err)
		return
	}
	c.sendEvent(Event{Op: OpHeartbeatAck})
}
