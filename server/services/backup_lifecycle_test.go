package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	for _, mode := range []string{"first-caller", "second-caller"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			svc, fake := newTestBackupService(t, config.BackupConfig{Enabled: true, HFToken: "fixture-token", HFBucket: "fixture/bucket", DBPath: filepath.Join(root, "data.db"), WorkDir: filepath.Join(root, "work")})
			entered, canceled, release, force, finished := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
			var enteredOnce, canceledOnce, finishedOnce, releaseOnce, forceOnce sync.Once
			fake.handler = func(ctx context.Context, call fakeCall) ([]byte, error) {
				defer finishedOnce.Do(func() { close(finished) })
				if _, err := healthySQLite("ok\n")(ctx, call); err != nil {
					return nil, err
				}
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
			secondStopped := make(chan struct{})
			secondLaunched := false
			t.Cleanup(func() {
				cancel()
				forceOnce.Do(func() { close(force) })
				releaseOnce.Do(func() { close(release) })
				waitBackupLifecycleSignal(t, finished, "final command exit")
				svc.backupMu.Lock()
				_, snapshotErr := os.Stat(filepath.Join(svc.cfg.WorkDir, "hichat-snapshot.db"))
				svc.backupMu.Unlock()
				if !errors.Is(snapshotErr, os.ErrNotExist) {
					t.Errorf("canceled cycle retained raw snapshot: %v", snapshotErr)
				}
				svc.Stop()
				waitBackupLifecycleSignal(t, stopped, "Shutdown return")
				if secondLaunched {
					waitBackupLifecycleSignal(t, secondStopped, "second Shutdown return")
				}
			})
			go func() { svc.Shutdown(ctx); close(stopped) }()
			waitBackupLifecycleSignal(t, entered, "final snapshot command entry")
			if mode == "first-caller" {
				cancel()
			} else {
				secondCtx, secondCancel := context.WithCancel(context.Background())
				defer secondCancel()
				secondLaunched = true
				go func() { svc.Shutdown(secondCtx); close(secondStopped) }()
				secondCancel()
			}
			waitBackupLifecycleSignal(t, canceled, "caller cancellation reaching final command")
			if mode == "second-caller" && ctx.Err() != nil {
				t.Fatal("second caller cancellation changed first caller context")
			}
			select {
			case <-stopped:
				t.Fatal("Shutdown returned before canceled final command finished")
			case <-secondStopped:
				t.Fatal("second Shutdown escaped final command join")
			case <-time.After(25 * time.Millisecond):
			}
			releaseOnce.Do(func() { close(release) })
			waitBackupLifecycleSignal(t, stopped, "final cycle join")
			if secondLaunched {
				waitBackupLifecycleSignal(t, secondStopped, "second final cycle join")
			}
			if got := len(fake.snapshot()); got != 1 {
				t.Fatalf("commands continued after final cancellation: %d", got)
			}

		})
	}
}

func TestBackupPeriodicStartOnceAndStopJoin(t *testing.T) {
	root := t.TempDir()
	svc, fake := newTestBackupService(t, config.BackupConfig{Enabled: true, HFToken: "fixture-token", HFBucket: "fixture/bucket", DBPath: filepath.Join(root, "data.db"), WorkDir: filepath.Join(root, "work"), Interval: time.Hour})
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
		if launched {
			waitBackupLifecycleSignal(t, stopped, "periodic Stop return")
		}
	})
	svc.startPeriodic(0)
	waitBackupLifecycleSignal(t, entered, "periodic snapshot entry")
	for i := 0; i < 20; i++ {
		svc.startPeriodic(0)
	}
	svc.lifecycleMu.Lock()
	active := svc.activeOperations
	svc.lifecycleMu.Unlock()
	if active != 1 {
		t.Fatalf("duplicate Start admitted extra periodic roots: %d", active)
	}
	launched = true
	go func() { svc.Stop(); close(stopped) }()
	waitBackupLifecycleSignal(t, canceled, "periodic cancellation")
	select {
	case <-stopped:
		t.Fatal("Stop escaped periodic cycle")
	case <-time.After(25 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	waitBackupLifecycleSignal(t, stopped, "periodic join")
	svc.startPeriodic(0)
	svc.runBackupCore(true)
	if got := len(fake.snapshot()); got != 1 {
		t.Fatalf("work admitted after terminal Stop: %d commands", got)
	}
}

func TestBackupConcurrentShutdownOwnsOneFinalCycle(t *testing.T) {
	root := t.TempDir()
	svc, fake := newTestBackupService(t, config.BackupConfig{Enabled: true, HFToken: "fixture-token", HFBucket: "fixture/bucket", DBPath: filepath.Join(root, "data.db"), WorkDir: filepath.Join(root, "work")})
	fake.handler = healthySQLite("ok\n")
	start, done := make(chan struct{}), make(chan struct{})
	var joined sync.WaitGroup
	joined.Add(20)
	for i := 0; i < 20; i++ {
		go func() { defer joined.Done(); <-start; svc.Shutdown(context.Background()) }()
	}
	go func() { joined.Wait(); close(done) }()
	t.Cleanup(func() { svc.Stop(); waitBackupLifecycleSignal(t, done, "concurrent final owners") })
	close(start)
	waitBackupLifecycleSignal(t, done, "concurrent Shutdown callers")
	cycles := 0
	for _, call := range fake.snapshot() {
		if call.name == "sqlite3" && len(call.args) > 0 && strings.HasPrefix(call.args[len(call.args)-1], "VACUUM INTO") {
			cycles++
		}
	}
	if cycles != 1 {
		t.Fatalf("final cycles=%d want1", cycles)
	}
}
