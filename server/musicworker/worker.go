package musicworker

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func workerURLs(endpoint string) (control, job *url.URL, err error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, nil, errors.New("music worker endpoint must be an HTTPS origin")
	}
	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		ip := net.ParseIP(u.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, nil, errors.New("unencrypted worker endpoint must use a loopback IP")
		}
		u.Scheme = "ws"
	default:
		return nil, nil, errors.New("music worker endpoint must be an HTTPS origin")
	}
	u.Path = ControlPath
	jobURL := *u
	jobURL.Path = JobPath
	return u, &jobURL, nil
}

// RunWorker maintains the outbound control connection and reconnects after
// transient failures. It returns after ctx cancellation, a configuration error,
// or authentication rejection. No endpoint redirect is followed.
func RunWorker(ctx context.Context, config WorkerConfig, runner Runner) error {
	if _, err := NewBroker(config.Token); err != nil {
		return err
	}
	if runner == nil {
		return errors.New("music worker runner is required")
	}
	controlURL, jobURL, err := workerURLs(config.Endpoint)
	if err != nil {
		return err
	}
	delay := config.ReconnectDelay
	if delay <= 0 {
		delay = time.Second
	}
	if delay > time.Minute {
		delay = time.Minute
	}
	for {
		err = runSession(ctx, controlURL, jobURL, config.Token, runner)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var typed *Error
		if errors.As(err, &typed) && typed.Code == "forbidden" {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func dialWorker(ctx context.Context, endpoint string, headers http.Header) (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096, Proxy: nil}
	conn, response, err := dialer.DialContext(ctx, endpoint, headers)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		if response != nil && response.StatusCode == http.StatusUnauthorized {
			return nil, &Error{Code: "forbidden"}
		}
		return nil, &Error{Code: "network"}
	}
	return conn, nil
}

func validID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func runSession(parent context.Context, controlURL, jobURL *url.URL, token string, runner Runner) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	header := http.Header{"Authorization": []string{"Bearer " + token}}
	conn, err := dialWorker(ctx, controlURL.String(), header)
	if err != nil {
		return err
	}
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	conn.SetReadLimit(controlBytes)
	_ = conn.SetReadDeadline(time.Now().Add(heartbeatTimeout))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(heartbeatTimeout)) })
	var hello wireMessage
	if conn.ReadJSON(&hello) != nil || hello.Type != "ready" || !validID(hello.Session) {
		return &Error{Code: "network"}
	}
	slog.Info("music worker connected")
	defer slog.Info("music worker disconnected")
	go heartbeat(conn, ctx.Done())
	var wg sync.WaitGroup
	defer func() { cancel(); _ = conn.Close(); wg.Wait() }()
	audioSlots := make(chan struct{}, 1)
	metadataSlots := make(chan struct{}, 1)
	for {
		var message wireMessage
		if conn.ReadJSON(&message) != nil {
			return &Error{Code: "network"}
		}
		if message.Type != "job" || !validID(message.ID) || message.Request == nil || message.Request.validate() != nil {
			return &Error{Code: "unknown"}
		}
		slots := metadataSlots
		if message.Request.Operation == OperationAudio {
			slots = audioSlots
		}
		// The broker may observe the final frame before the previous callback
		// finishes reaping its subprocess. Wait for that slot instead of
		// spuriously disconnecting an otherwise healthy worker.
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		wg.Add(1)
		go func(message wireMessage, slots chan struct{}) {
			defer wg.Done()
			defer func() { <-slots }()
			runJob(ctx, jobURL, token, hello.Session, message, runner)
		}(message, slots)
	}
}

func runJob(parent context.Context, baseURL *url.URL, token, session string, message wireMessage, runner Runner) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	endpoint := *baseURL
	query := endpoint.Query()
	query.Set("id", message.ID)
	endpoint.RawQuery = query.Encode()
	header := http.Header{"Authorization": []string{"Bearer " + token}, sessionHeader: []string{session}}
	conn, err := dialWorker(ctx, endpoint.String(), header)
	if err != nil {
		return
	}
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	conn.SetReadLimit(1024)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		// The fixed one-way keepalive keeps proxies active during an audio
		// pause. It needs no reply from the potentially blocked audio writer.
		// Closure or any other application data cancels the subprocess.
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil || kind != websocket.TextMessage || string(data) != jobKeepaliveMessage {
				return
			}
		}
	}()
	writer := &jobWriter{ctx: ctx, conn: conn, metadata: message.Request.Operation != OperationAudio}
	err = runner(ctx, *message.Request, writer)
	if err == nil {
		err = writer.failed
	}
	if ctx.Err() == nil {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if conn.WriteJSON(wireMessage{Type: "result", Code: errorCode(err)}) != nil {
			_ = conn.Close()
		}
	}
	// A successful write only reaches the upstream proxy, not necessarily the
	// playback-paced broker. Keep reading keepalives until the broker consumes
	// the terminal frame and closes; cancellation still closes via stopClose.
	<-readerDone
}

type jobWriter struct {
	ctx      context.Context
	conn     *websocket.Conn
	metadata bool
	written  int64
	failed   error
}

func (w *jobWriter) Write(data []byte) (int, error) {
	if w.failed != nil {
		return 0, w.failed
	}
	if err := w.ctx.Err(); err != nil {
		w.failed = err
		return 0, err
	}
	if w.metadata && w.written+int64(len(data)) > MaxMetadataBytes {
		w.failed = &Error{Code: "output_limit"}
		return 0, w.failed
	}
	written := 0
	for len(data) > 0 {
		size := min(len(data), frameBytes)
		if err := w.conn.WriteMessage(websocket.BinaryMessage, data[:size]); err != nil {
			w.failed = &Error{Code: "network"}
			return written, w.failed
		}
		written += size
		w.written += int64(size)
		data = data[size:]
	}
	return written, nil
}

var _ io.Writer = (*jobWriter)(nil)
