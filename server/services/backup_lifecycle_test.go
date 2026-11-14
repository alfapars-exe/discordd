package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/config"
)

func waitBackupLifecycleSignal(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestBackupStopJoinsCanceledUploadsRestore(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "data.db")
	if err := os.WriteFile(db, make([]byte, 8192), 0o600); err != nil {
		t.Fatal(err)
	}
	svc, fake := newTestBackupService(t, config.BackupConfig{Enabled: true, HFToken: "fixture-token", HFBucket: "fixture/bucket", DBPath: db, UploadDir: filepath.Join(root, "uploads")})
	entered, canceled, release, force := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var enteredOnce, canceledOnce, releaseOnce, forceOnce sync.Once
	fake.handler = func(ctx context.Context, _ fakeCall) ([]byte, error) {
		enteredOnce.Do(func() { close(entered) })
		select {
		case <-ctx.Done():
			canceledOnce.Do(func() { close(canceled) })
		case <-force:
			return nil, errors.New("fixture cleanup")
		}
		<-release
		return nil, ctx.Err()
	}
	stopped := make(chan struct{})
	launched := false
	t.Cleanup(func() {
		forceOnce.Do(func() { close(force) })
		releaseOnce.Do(func() { close(release) })
		svc.Stop()
		svc.waitForUploadsRestore()
		if launched {
			waitBackupLifecycleSignal(t, stopped, "Stop return")
		}
	})
	if err := svc.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitBackupLifecycleSignal(t, entered, "restore command entry")
	launched = true
	go func() { svc.Stop(); close(stopped) }()
	waitBackupLifecycleSignal(t, canceled, "restore command cancellation")
	select {
	case <-stopped:
		t.Fatal("Stop returned before canceled uploads restore finished")
	case <-time.After(25 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	waitBackupLifecycleSignal(t, stopped, "Stop join")
	if err := svc.Restore(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Restore admitted after Stop: %v", err)
	}
	if got := len(fake.snapshot()); got != 1 {
		t.Fatalf("late restore invoked more commands: %d", got)
	}
}

func TestBackupShutdownCancelsAndJoinsFinalCycle(t *testing.T) {
	root := t.TempDir()
	svc, fake := newTestBackupService(t, config.BackupConfig{Enabled: true, HFToken: "fixture-token", HFBucket: "fixture/bucket", DBPath: filepath.Join(root, "data.db"), WorkDir: filepath.Join(root, "work")})
	entered, canceled, release, force, finished := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var enteredOnce, canceledOnce, finishedOnce, releaseOnce, forceOnce sync.Once
	fake.handler = func(ctx context.Context, _ fakeCall) ([]byte, error) {
		defer finishedOnce.Do(func() { close(finished) })
		enteredOnce.Do(func() { close(entered) })
		select {
		case <-ctx.Done():
			canceledOnce.Do(func() { close(canceled) })
		case <-force:
			return nil, errors.New("fixture cleanup")
		}
		<-release
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		forceOnce.Do(func() { close(force) })
		releaseOnce.Do(func() { close(release) })
		waitBackupLifecycleSignal(t, finished, "final command exit")
		svc.backupMu.Lock()
		svc.backupMu.Unlock()
		svc.Stop()
		waitBackupLifecycleSignal(t, stopped, "Shutdown return")
	})
	go func() { svc.Shutdown(ctx); close(stopped) }()
	waitBackupLifecycleSignal(t, entered, "final snapshot command entry")
	cancel()
	waitBackupLifecycleSignal(t, canceled, "caller cancellation reaching final command")
	select {
	case <-stopped:
		t.Fatal("Shutdown returned before canceled final command finished")
	case <-time.After(25 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	waitBackupLifecycleSignal(t, stopped, "final cycle join")
	if got := len(fake.snapshot()); got != 1 {
		t.Fatalf("commands continued after final cancellation: %d", got)
	}
}
