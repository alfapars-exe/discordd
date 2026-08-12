// Client event dispatch: op-code handler registry, rate limiting, and panic recovery.
package ws

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
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
		// slog, not log.Printf: this reaches Sentry (>= Error is forwarded,
		// see pkg/logx/sentry.go) and event.Op — client-controlled — goes in
		// as a structured attr instead of into a format string, so a
		// malicious op value can't forge or split log lines (G706).
		slog.LogAttrs(context.Background(), slog.LevelError, "ws handler panic recovered",
			slog.String("user_id", c.userID),
			slog.String("op", event.Op),
			slog.String("panic", fmt.Sprintf("%v", r)),
			slog.String("stack", string(stack)),
		)
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

	// Bots are read-only gateway consumers (bot_gateway.go): they act via the
	// REST API, never by sending ops over the socket. Enforce that here — the
	// single inbound chokepoint, symmetric with deliver's outbound bot filter
	// (hub_broadcast.go) — so a bot token can't drive voice moves, presence, or
	// P2P signalling over WS. Heartbeat is exempt: it carries no action and
	// refreshes the read deadline (handleHeartbeat), so a heartbeat keepalive
	// still works.
	if c.isBot && event.Op != OpHeartbeat {
		dispatchLogger.Warn("bot inbound op rejected", "user_id", c.userID, "op", event.Op)
		return
	}

	if c.rateLimit == nil {
		c.rateLimit = newClientRateLimiter()
	}
	if !c.rateLimit.allow(event.Op) {
		// Rate-limit drops are common enough during typing storms that
		// logging every one would flood the log. Only log every Nth or
		// at a sampled rate in production — for now we keep it visible
		// while the limits are being tuned.
		// event.Op is client-controlled — passed as a structured attr, not
		// interpolated into the message, so it can't forge or split log lines (G706).
		dispatchLogger.Warn("rate limit exceeded, event dropped", "user_id", c.userID, "op", event.Op)
		c.hub.rateLimitDrops.Add(1)
		return
	}

	if handler, ok := eventHandlers[event.Op]; ok {
		c.hub.dispatchCount.Add(1)
		handler(c, event)
		return
	}
	dispatchLogger.Warn("unknown op from client", "user_id", c.userID, "op", event.Op)
}

// handleHeartbeat resets the read deadline and acks the client's heartbeat.
func (c *Client) handleHeartbeat(_ Event) {
	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		dispatchLogger.Error("failed to set read deadline", "user_id", c.userID, "err", pkg.ErrText(err))
		return
	}
	c.sendEvent(Event{Op: OpHeartbeatAck})
}
