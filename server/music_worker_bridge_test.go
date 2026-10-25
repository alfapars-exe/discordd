package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

func TestMusicWorkerBridgeDisabled(t *testing.T) {
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN", "")
	t.Setenv("HICHAT_MUSIC_EXECUTOR_SOCKET", "stale-socket")
	mux := http.NewServeMux()
	bridge, err := startMusicWorkerBridge(mux)
	if err != nil || bridge != nil {
		t.Fatalf("disabled bridge = %v, %v", bridge, err)
	}
	if os.Getenv("HICHAT_MUSIC_EXECUTOR_SOCKET") != "" {
		t.Fatal("inherited executor socket was not cleared")
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, musicworker.ControlPath, nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("disabled worker registered a public route: %d", response.Code)
	}
}

func TestMusicWorkerBridgePrivateExecutorLifecycle(t *testing.T) {
	// Production runs on Linux; Windows does not consistently support Unix
	// sockets and Unix ownership bits across supported desktop versions.
	if runtime.GOOS == "windows" {
		t.Skip("Linux container integration covers private Unix socket lifecycle")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "hichat-media-exec"), []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN", strings.Repeat("a", 40))
	t.Setenv("HICHAT_MUSIC_EXECUTOR_SOCKET", "")
	mux := http.NewServeMux()
	bridge, err := startMusicWorkerBridge(mux)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bridge.Close)
	socket := os.Getenv("HICHAT_MUSIC_EXECUTOR_SOCKET")
	for path, mode := range map[string]os.FileMode{bridge.dir: 0o700, socket: 0o600} {
		info, statErr := os.Stat(path)
		if statErr != nil || info.Mode().Perm() != mode {
			t.Fatalf("private path permissions: path=%s error=%v", path, statErr)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err = musicworker.Execute(ctx, socket, musicworker.Request{Operation: musicworker.OperationMetadata, Input: "https://www.youtube.com/watch?v=0KbRhUtFwkc"}, io.Discard)
	var workerErr *musicworker.Error
	if !errors.As(err, &workerErr) || workerErr.Code != "offline" {
		t.Fatalf("offline executor error = %v", err)
	}
	for _, path := range []string{musicworker.ControlPath, musicworker.JobPath} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s returned %d", path, response.Code)
		}
	}
	bridge.Close()
	bridge.Close()
	if _, err := os.Stat(bridge.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("executor directory survived shutdown: %v", err)
	}
	if os.Getenv("HICHAT_MUSIC_EXECUTOR_SOCKET") != "" {
		t.Fatal("executor environment survived shutdown")
	}
}

func TestMusicWorkerSocketPathsAreExact(t *testing.T) {
	for _, path := range []string{musicworker.ControlPath, musicworker.JobPath} {
		if !isMusicWorkerSocketPath(path) || isMusicWorkerSocketPath(path+"/") || isMusicWorkerSocketPath(path+"-extra") {
			t.Fatalf("worker socket route match is not exact: %s", path)
		}
	}
}
