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
// hf/sqlite3 or inheriting provider credentials. The child self-exits as a
// cleanup fallback if cancellation regresses.
func TestBackupCommandCancellationJoinsOwnedProcess(t *testing.T) {
	const childFlag = "HICHAT_BACKUP_COMMAND_CHILD"
	const markerFlag = "HICHAT_BACKUP_COMMAND_MARKER"
	if os.Getenv(childFlag) == "1" {
		if err := os.WriteFile(os.Getenv(markerFlag), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Second)
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var runErr error
	go func() {
		_, runErr = defaultRunCmd(ctx, []string{childFlag + "=1", markerFlag + "=" + marker, "PATH=" + os.Getenv("PATH"), "TMPDIR=" + dir}, executable, "-test.run=^TestBackupCommandCancellationJoinsOwnedProcess$")
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
