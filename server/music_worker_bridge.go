package main

import (
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

// The executor socket is local to this process tree. Only the two authenticated
// worker WebSocket handlers are registered on the application's public mux.
type musicWorkerBridge struct {
	broker *musicworker.Broker
	server *http.Server
	dir    string
	once   sync.Once
}

func startMusicWorkerBridge(mux *http.ServeMux) (*musicWorkerBridge, error) {
	// This variable is generated below; a stale external value must never route
	// local yt-dlp calls to an unrelated socket.
	if err := os.Unsetenv("HICHAT_MUSIC_EXECUTOR_SOCKET"); err != nil {
		return nil, errors.New("cannot reset music executor environment")
	}
	token := os.Getenv("HICHAT_MUSIC_WORKER_TOKEN")
	if token == "" {
		return nil, nil
	}
	if _, err := exec.LookPath("hichat-media-exec"); err != nil {
		return nil, errors.New("music worker enabled but hichat-media-exec is missing")
	}
	broker, err := musicworker.NewBroker(token)
	if err != nil {
		return nil, errors.New("invalid music worker configuration")
	}
	dir, err := os.MkdirTemp("", "hichat-music-")
	if err != nil {
		_ = broker.Close()
		return nil, errors.New("cannot create private music executor directory")
	}
	bridge := &musicWorkerBridge{broker: broker, dir: dir}
	// MkdirTemp creates mode 0700. The socket is also explicitly private so a
	// future directory permission change cannot expose the executor endpoint.
	socket := filepath.Join(dir, "executor.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		bridge.Close()
		return nil, errors.New("cannot listen on private music executor socket")
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		_ = listener.Close()
		bridge.Close()
		return nil, errors.New("cannot restrict music executor socket permissions")
	}
	privateMux := http.NewServeMux()
	privateMux.HandleFunc("POST /run", broker.ExecutorHandler)
	bridge.server = &http.Server{
		Handler:           privateMux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8192,
		// Audio may stream for hours, with bounded buffering in the broker.
	}
	if err := os.Setenv("HICHAT_MUSIC_EXECUTOR_SOCKET", socket); err != nil {
		_ = listener.Close()
		bridge.Close()
		return nil, errors.New("cannot configure music executor socket")
	}
	mux.HandleFunc("GET "+musicworker.ControlPath, broker.ControlHandler)
	mux.HandleFunc("GET "+musicworker.JobPath, broker.JobHandler)
	go func() {
		if err := bridge.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// No request data, cookies, or authentication values enter this log.
			bootLogger.Error("private music executor stopped")
		}
	}()
	bootLogger.Info("remote music executor enabled")
	return bridge, nil
}

func (b *musicWorkerBridge) Close() {
	if b == nil {
		return
	}
	b.once.Do(func() {
		_ = b.broker.Close() // HTTP Shutdown does not close hijacked WebSockets.
		if b.server != nil {
			_ = b.server.Close()
		}
		_ = os.Unsetenv("HICHAT_MUSIC_EXECUTOR_SOCKET")
		// dir is exclusively created by MkdirTemp above, never user supplied.
		_ = os.RemoveAll(b.dir)
	})
}

func isMusicWorkerSocketPath(path string) bool {
	return path == musicworker.ControlPath || path == musicworker.JobPath
}
