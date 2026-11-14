package services

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// Exercise the real runner against an owned helper process, without invoking
// hf/sqlite3 or inheriting provider credentials. The fixture self-exits as a
// cleanup fallback if cancellation regresses.
func TestBackupCommandCancellationJoinsOwnedProcess(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var runErr error
	go func() {
		// Use a tiny fixed Linux fixture instead of starting another complete
		// race/coverage-instrumented services test binary. exec preserves the
		// marker PID, so cancellation must reap that exact owned process.
		// The path is a positional argument; no user/path text enters shell code.
		_, runErr = defaultRunCmd(ctx, []string{"PATH=/usr/bin:/bin"}, "/bin/sh", "-c", `printf '%s' "$$" > "$1"; exec sleep 20`, "backup-command-fixture", marker)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(25 * time.Second):
			t.Error("owned helper failed to exit")
		}
	})
	ready := time.NewTimer(3 * time.Second)
	defer ready.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	pid := 0
	for pid == 0 {
		if data, err := os.ReadFile(marker); err == nil {
			pid, _ = strconv.Atoi(string(data))
		}
		if pid != 0 {
			break
		}
		select {
		case <-done:
			t.Fatalf("helper exited before readiness: %v", runErr)
		case <-ready.C:
			t.Fatal("owned helper did not start")
		case <-poll.C:
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("command outlived cancellation")
	}
	if runErr == nil {
		t.Fatal("canceled command unexpectedly succeeded")
	}
	if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
		t.Fatalf("owned process still exists after runner return: %v", err)
	}
}
