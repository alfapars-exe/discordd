//go:build linux

package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

func TestMusicWorkerLinuxCancellationKillsDescendants(t *testing.T) {
	useMusicWorkerTestDNS(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := &musicWorkerPIDWriter{cancel: cancel}
	config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMusicWorkerLinuxProcessHelper$", "--", "parent")
	}}
	err := runMusicWorkerJob(ctx, config, os.Args[0], musicworker.Request{Operation: "audio", Input: workerTestURL}, writer)
	if !errors.Is(err, context.Canceled) || writer.pid <= 0 || writer.canceledAt.IsZero() || time.Since(writer.canceledAt) > 3*time.Second {
		t.Fatalf("parent not canceled: %v", err)
	}
	// A minimal container's PID1 may temporarily leave an orphaned zombie. It
	// is no longer executing or holding resources; anything running is a leak.
	deadline := time.Now().Add(time.Second)
	for {
		data, readErr := os.ReadFile(fmt.Sprintf("/proc/%d/stat", writer.pid))
		if os.IsNotExist(readErr) || errors.Is(syscall.Kill(writer.pid, 0), syscall.ESRCH) {
			return
		}
		fields := strings.Fields(string(data))
		if len(fields) > 2 && fields[2] == "Z" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("descendant kept running after cancellation")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type musicWorkerPIDWriter struct {
	cancel     context.CancelFunc
	pid        int
	canceledAt time.Time
}

func (w *musicWorkerPIDWriter) Write(data []byte) (int, error) {
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, err
	}
	w.pid = pid
	w.canceledAt = time.Now()
	w.cancel()
	return len(data), nil
}

func TestMusicWorkerLinuxProcessHelper(t *testing.T) {
	index := slices.Index(os.Args, "--")
	if index < 0 || index+1 >= len(os.Args) {
		return
	}
	if os.Args[index+1] == "parent" {
		child := exec.Command(os.Args[0], "-test.run=^TestMusicWorkerLinuxProcessHelper$", "--", "child")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stdout, child.Process.Pid)
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}
