package ws

import (
	"testing"
	"time"
)

// Bots connect to the gateway as read-only consumers and act via REST; the
// gateway doc (bot_gateway.go) and the outbound deliver filter both assume
// they never send action ops over the socket. handleEvent enforces that on the
// inbound side. These pin it: a bot's action op is dropped before its handler
// runs, while a human's identical op dispatches.

func TestBotInboundActionOpRejected(t *testing.T) {
	h := NewHub()
	fired := make(chan struct{}, 1)
	// onChannelTyping is invoked asynchronously (logx.Go), so assert on a
	// window: without the gate the callback goroutine fires within it; with the
	// gate it is never scheduled, so the window elapses cleanly.
	h.onChannelTyping = func(_, _, _ string) { fired <- struct{}{} }

	bot := &Client{hub: h, userID: "bot", send: make(chan []byte, 4), done: make(chan struct{}), isBot: true}
	bot.handleEvent(Event{Op: OpTyping, Data: map[string]string{"channel_id": "ch1"}})

	select {
	case <-fired:
		t.Error("bot OpTyping reached the handler, want it rejected before dispatch")
	case <-time.After(300 * time.Millisecond):
		// rejected — the handler never ran
	}
}

func TestHumanInboundOpDispatches(t *testing.T) {
	h := NewHub()
	fired := make(chan struct{}, 1)
	h.onChannelTyping = func(_, _, _ string) { fired <- struct{}{} }

	human := &Client{hub: h, userID: "u1", send: make(chan []byte, 4), done: make(chan struct{})}
	human.handleEvent(Event{Op: OpTyping, Data: map[string]string{"channel_id": "ch1"}})

	select {
	case <-fired:
		// dispatched — the gate does not over-reject humans
	case <-time.After(2 * time.Second):
		t.Error("human OpTyping did not reach the handler")
	}
}
