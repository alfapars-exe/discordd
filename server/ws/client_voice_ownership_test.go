package ws

import (
	"sync"
	"testing"
	"time"
)

func TestVoiceActivityCallbackJoinsHubShutdown(t *testing.T) {
	h := NewHub()
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	h.OnVoiceActivity(func(string) { close(entered); <-release; close(finished) })
	var once sync.Once
	t.Cleanup(func() {
		once.Do(func() { close(release) })
		h.Shutdown()
		waitSignal(t, finished, "voice activity exit")
	})
	c := &Client{hub: h, userID: "speaker"}
	c.handleVoiceActivity()
	waitSignal(t, entered, "voice activity entry")
	stopped := make(chan struct{})
	go func() { h.Shutdown(); close(stopped) }()
	waitSignal(t, h.presenceCallbacks.stopSubmit, "callback owner shutdown admission")
	select {
	case <-h.presenceCallbacks.shutdownDone:
		t.Fatal("Hub callback owner stopped while accepted voice activity was running")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	waitSignal(t, stopped, "voice callback join")
}

func TestVoiceActivityCallbackRejectsAfterHubShutdown(t *testing.T) {
	h := NewHub()
	called := make(chan struct{}, 1)
	h.OnVoiceActivity(func(string) { called <- struct{}{} })
	h.Shutdown()
	c := &Client{hub: h, userID: "late-speaker"}
	c.handleVoiceActivity()
	select {
	case <-called:
		t.Fatal("voice activity admitted after Hub shutdown")
	case <-time.After(25 * time.Millisecond):
	}
}
