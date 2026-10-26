package musicjs

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type Bridge struct {
	Path    string
	client  *Client
	server  *http.Server
	cancel  context.CancelFunc
	once    sync.Once
	mu      sync.Mutex
	failure *Error
	active  chan struct{}
	done    chan struct{}
}

func StartBridge(parent context.Context, privateDir string, client *Client) (*Bridge, error) {
	if client == nil || !filepath.IsAbs(privateDir) {
		return nil, &Error{Code: "invalid_request"}
	}
	info, err := os.Lstat(privateDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, &Error{Code: "invalid_request"}
	}
	path := filepath.Join(privateDir, "js.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, &Error{Code: "unavailable"}
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, &Error{Code: "unavailable"}
	}
	ctx, cancel := context.WithCancel(parent)
	b := &Bridge{Path: path, client: client, cancel: cancel, active: make(chan struct{}, 1), done: make(chan struct{})}
	b.server = &http.Server{Handler: http.HandlerFunc(b.handle), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 40 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { defer close(b.done); _ = b.server.Serve(listener) }()
	go func() { <-ctx.Done(); _ = b.server.Close() }()
	return b, nil
}

func (b *Bridge) Close() {
	b.once.Do(func() { b.cancel(); _ = b.server.Close(); <-b.done; _ = os.Remove(b.Path) })
}
func (b *Bridge) Failure() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure == nil {
		return nil
	}
	return &Error{Code: b.failure.Code}
}
func (b *Bridge) record(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure == nil {
		b.failure = &Error{Code: ErrorCode(err)}
	}
}
func writeBridgeError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadGateway)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": ErrorCode(err)})
}

func (b *Bridge) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/solve" || r.Header.Get("Origin") != "" {
		http.NotFound(w, r)
		return
	}
	select {
	case b.active <- struct{}{}:
		defer func() { <-b.active }()
	default:
		err := &Error{Code: "busy"}
		b.record(err)
		writeBridgeError(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxInputBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		err = &Error{Code: "payload_too_large"}
		b.record(err)
		writeBridgeError(w, err)
		return
	}
	request, err := ParseRequest(data)
	if err != nil {
		b.record(err)
		writeBridgeError(w, err)
		return
	}
	result, err := b.client.solve(r.Context(), data, request)
	if err != nil {
		b.record(err)
		writeBridgeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(result)
}
