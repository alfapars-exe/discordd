package ws

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGameActivitySnapshotShutdownJoinsAcceptedCallback(t *testing.T) {
	h := NewHub()
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	h.OnGameActivitySnapshot(func(string) { close(entered); <-release; close(finished) })
	var once sync.Once
	t.Cleanup(func() {
		once.Do(func() { close(release) })
		h.Shutdown()
		select {
		case <-entered:
			waitSignal(t, finished, "snapshot callback exit")
		default:
		}
	})
	h.RequestGameActivitySnapshot("viewer")
	waitSignal(t, entered, "snapshot callback entry")
	stopped := make(chan struct{})
	go func() { h.Shutdown(); close(stopped) }()
	waitSignal(t, h.presenceCallbacks.stopSubmit, "callback owner shutdown admission")
	select {
	case <-h.presenceCallbacks.shutdownDone:
		t.Fatal("callback owner finished shutdown while snapshot was still running")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	waitSignal(t, stopped, "Hub shutdown join")
	waitSignal(t, finished, "snapshot callback exit")
}

func TestGameActivitySnapshotRejectsAfterShutdown(t *testing.T) {
	h := NewHub()
	called := make(chan struct{}, 1)
	h.OnGameActivitySnapshot(func(string) { called <- struct{}{} })
	h.Shutdown()
	h.RequestGameActivitySnapshot("late-viewer")
	select {
	case <-called:
		t.Fatal("snapshot callback admitted after Hub shutdown")
	case <-time.After(25 * time.Millisecond):
	}
}

func TestGameActivitySnapshotsPreserveUserOrderWithoutBlockingOtherUsers(t *testing.T) {
	h := NewHub()
	first, second, other := make(chan struct{}), make(chan struct{}), make(chan struct{})
	release, finished := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	h.OnGameActivitySnapshot(func(user string) {
		if user == "other" {
			close(other)
			return
		}
		if count.Add(1) == 1 {
			close(first)
			<-release
			close(finished)
			return
		}
		close(second)
	})
	var once sync.Once
	t.Cleanup(func() {
		once.Do(func() { close(release) })
		h.Shutdown()
		select {
		case <-first:
			waitSignal(t, finished, "first snapshot exit")
		default:
		}
	})
	h.RequestGameActivitySnapshot("same")
	waitSignal(t, first, "first snapshot entry")
	h.RequestGameActivitySnapshot("same")
	h.RequestGameActivitySnapshot("other")
	waitSignal(t, other, "independent viewer snapshot")
	select {
	case <-second:
		t.Fatal("same-user snapshot overtook accepted predecessor")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	waitSignal(t, second, "ordered snapshot successor")
}
