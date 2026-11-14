package ws

import (
	"sync"
	"testing"
	"time"
)

type clientCallbackOwnershipCase struct {
	name     string
	install  func(*Hub, func())
	dispatch func(*Client)
}

func TestRemainingClientCallbacksJoinHubShutdown(t *testing.T) {
	cases := []clientCallbackOwnershipCase{
		{"p2p_end", func(h *Hub, fn func()) { h.OnP2PCallEnd(func(string, string) { fn() }) }, func(c *Client) { c.handleP2PCallEnd(Event{}) }},
		{"channel_typing", func(h *Hub, fn func()) { h.OnChannelTyping(func(string, string, string) { fn() }) }, func(c *Client) { c.handleTyping(Event{Data: map[string]any{"channel_id": "channel"}}) }},
		{"dm_typing", func(h *Hub, fn func()) { h.OnDMTyping(func(string, string, string) { fn() }) }, func(c *Client) { c.handleDMTyping(Event{Data: map[string]any{"dm_channel_id": "dm"}}) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { checkClientCallbackOwnership(t, tc) })
	}
}

func checkClientCallbackOwnership(t *testing.T, tc clientCallbackOwnershipCase) {
	t.Helper()
	h := NewHub()
	called, finished := make(chan struct{}, 2), make(chan struct{}, 2)
	release := make(chan struct{})
	tc.install(h, func() { called <- struct{}{}; <-release; finished <- struct{}{} })
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); h.Shutdown(); waitSignal(t, finished, "callback exit") })
	c := &Client{hub: h, userID: "actor"}
	tc.dispatch(c)
	waitSignal(t, called, "callback entry")
	stopped := make(chan struct{})
	go func() { h.Shutdown(); close(stopped) }()
	waitSignal(t, h.presenceCallbacks.stopSubmit, "owner admission fence")
	select {
	case <-h.presenceCallbacks.shutdownDone:
		t.Fatal("callback escaped Hub shutdown owner")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	waitSignal(t, stopped, "callback owner join")
	tc.dispatch(c)
	select {
	case <-called:
		t.Fatal("callback admitted after Hub shutdown")
	case <-time.After(25 * time.Millisecond):
	}
}
