package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackendOwnerWatchStopCancelsAndJoinsBeforeConnectionClose(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	started, cancelled, release, exited := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		close(exited)
	})
	t.Cleanup(func() { cancelParent(); releaseOnce.Do(func() { close(release) }); stop() })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("watch did not start")
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-cancelled:
	case <-stopped:
		t.Fatal("cleanup returned without cancelling ownership watch")
	case <-time.After(time.Second):
		t.Fatal("watch context was not cancelled")
	}
	if parent.Err() != nil {
		t.Fatal("watch cleanup cancelled its caller context")
	}
	select {
	case <-stopped:
		t.Fatal("cleanup returned before watch completion; connection could close too early")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not join the completed watch")
	}
	select {
	case <-exited:
	default:
		t.Fatal("watch remains active after cleanup")
	}
}

func TestBackendOwnerWatchSupportsConcurrentCleanup(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	var calls atomic.Int32
	stoppedWatch := make(chan struct{})
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) { calls.Add(1); <-ctx.Done(); close(stoppedWatch) })
	t.Cleanup(func() { cancelParent(); stop() })
	var owners sync.WaitGroup
	owners.Add(16)
	for i := 0; i < 16; i++ {
		go func() { defer owners.Done(); stop() }()
	}
	owners.Wait()
	select {
	case <-stoppedWatch:
	default:
		t.Fatal("concurrent cleanup did not wait for ownership watch")
	}
	if calls.Load() != 1 {
		t.Fatalf("watch started %d times", calls.Load())
	}
	if parent.Err() != nil {
		t.Fatal("cleanup cancelled shared parent context")
	}
	stop()
}

func TestBackendOwnerWatchParentCancellationPropagates(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	exited := make(chan struct{})
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) { <-ctx.Done(); close(exited) })
	t.Cleanup(func() { cancel(); stop() })
	cancel()
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("parent cancellation did not reach watch")
	}
	stop()
}

func TestMainDefersWatchJoinBeforeOwnershipConnectionClose(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	connectionClose := strings.Index(source, "defer func() { _ = owner.Close() }()")
	watchCleanup := strings.Index(source, "defer stopOwnerWatch()")
	if connectionClose < 0 || watchCleanup < connectionClose || strings.Count(source, "defer stopOwnerWatch()") != 1 {
		t.Fatal("main must register watch cleanup after connection close so LIFO joins watch first")
	}
	poolClose := strings.Index(source, "if err := db.Close();")
	explicitJoin := strings.Index(source, "\n\tstopOwnerWatch()\n")
	if explicitJoin < 0 || poolClose < explicitJoin {
		t.Fatal("ownership watch must join before the database pool closes")
	}
	if !strings.Contains(source, "database.WatchBackendOwner(watchCtx, owner,") || strings.Contains(source, "go database.WatchBackendOwner(") {
		t.Fatal("ownership observer bypasses its owned child context")
	}
}
