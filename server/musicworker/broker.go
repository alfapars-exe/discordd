package musicworker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	frameBytes          = 64 << 10
	controlBytes        = 16 << 10
	jobErrorTrailer     = "X-Music-Worker-Error"
	sessionHeader       = "X-Music-Worker-Session"
	heartbeatInterval   = 15 * time.Second
	heartbeatTimeout    = 45 * time.Second
	attachTimeout       = 10 * time.Second
	jobKeepaliveMessage = `{"type":"keepalive"}`
)

type wireMessage struct {
	Type    string   `json:"type"`
	Session string   `json:"session,omitempty"`
	ID      string   `json:"id,omitempty"`
	Request *Request `json:"request,omitempty"`
	Code    string   `json:"code,omitempty"`
}

type jobEvent struct {
	data     []byte
	code     string
	terminal bool
}

type brokerJob struct {
	id       string
	session  *brokerSession
	request  Request
	ctx      context.Context
	cancel   context.CancelFunc
	attached chan struct{}
	events   chan jobEvent
	claimed  bool
	conn     *websocket.Conn // guarded by Broker.mu
}

type brokerSession struct {
	id       string
	conn     *websocket.Conn
	sendMu   sync.Mutex
	done     chan struct{}
	stopOnce sync.Once
	ready    bool // guarded by Broker.mu
}

func (s *brokerSession) send(msg wireMessage) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.conn.WriteJSON(msg)
}

func (s *brokerSession) stop() {
	s.stopOnce.Do(func() { close(s.done); _ = s.conn.Close() })
}

// Broker admits one worker and at most one audio and one metadata/search job.
// ExecutorHandler is private: expose it only on a permission-restricted Unix
// socket. ControlHandler and JobHandler may be exposed through the public HTTPS
// listener; both independently authenticate the worker token.
type Broker struct {
	token                string
	mu                   sync.Mutex
	session              *brokerSession
	jobs                 map[string]*brokerJob
	audioBusy            bool
	metadataBusy         bool
	closed               bool
	jobKeepaliveInterval time.Duration
}

func NewBroker(token string) (*Broker, error) {
	if len(token) < 32 || len(token) > 512 || strings.ContainsAny(token, "\r\n\x00") {
		return nil, errors.New("music worker token must contain 32 to 512 safe characters")
	}
	return &Broker{token: token, jobs: make(map[string]*brokerJob), jobKeepaliveInterval: heartbeatInterval}, nil
}

func randomID() string {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("secure randomness unavailable")
	}
	return hex.EncodeToString(value[:])
}

func (b *Broker) authorized(r *http.Request) bool {
	// Browser-origin requests have no role in this service-to-service channel.
	if r.Header.Get("Origin") != "" {
		return false
	}
	value := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && subtle.ConstantTimeCompare([]byte(value), []byte(b.token)) == 1
}

var workerUpgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	ReadBufferSize:   4096,
	WriteBufferSize:  4096,
	CheckOrigin:      func(r *http.Request) bool { return r.Header.Get("Origin") == "" },
}

func (b *Broker) ControlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	b.mu.Lock()
	if b.closed || b.session != nil {
		b.mu.Unlock()
		http.Error(w, "worker unavailable", http.StatusConflict)
		return
	}
	conn, err := workerUpgrader.Upgrade(w, r, nil)
	if err != nil {
		b.mu.Unlock()
		return
	}
	s := &brokerSession{id: randomID(), conn: conn, done: make(chan struct{})}
	b.session = s
	b.mu.Unlock()
	defer b.removeSession(s)
	conn.SetReadLimit(controlBytes)
	_ = conn.SetReadDeadline(time.Now().Add(heartbeatTimeout))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(heartbeatTimeout)) })
	if s.send(wireMessage{Type: "ready", Session: s.id}) != nil {
		return
	}
	b.mu.Lock()
	s.ready = true
	b.mu.Unlock()
	slog.Info("music worker connected")
	defer slog.Info("music worker disconnected")
	go heartbeat(s.conn, s.done)
	// Worker control traffic is solely ping/pong, handled inside ReadMessage.
	// Closure or any application message ends this control session. Jobs and
	// results use their own socket, so paused playback cannot block liveness.
	_, _, _ = conn.ReadMessage()
}

func heartbeat(conn *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)) != nil {
				_ = conn.Close()
				return
			}
		}
	}
}

func (b *Broker) removeSession(s *brokerSession) {
	s.stop()
	b.mu.Lock()
	if b.session == s {
		b.session = nil
	}
	for _, job := range b.jobs {
		if job.session == s {
			job.cancel()
			if job.conn != nil {
				_ = job.conn.Close()
			}
		}
	}
	b.mu.Unlock()
}

func (b *Broker) JobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	b.mu.Lock()
	job := b.jobs[r.URL.Query().Get("id")]
	if job == nil || job.claimed || job.ctx.Err() != nil || b.session != job.session || subtle.ConstantTimeCompare([]byte(r.Header.Get(sessionHeader)), []byte(job.session.id)) != 1 {
		b.mu.Unlock()
		http.Error(w, "job unavailable", http.StatusGone)
		return
	}
	conn, err := workerUpgrader.Upgrade(w, r, nil)
	if err != nil {
		b.mu.Unlock()
		return
	}
	job.claimed = true
	job.conn = conn
	keepaliveInterval := b.jobKeepaliveInterval
	close(job.attached)
	b.mu.Unlock()
	defer conn.Close()
	keepaliveDone := make(chan struct{})
	defer close(keepaliveDone)
	go keepJobAlive(job, conn, keepaliveDone, keepaliveInterval)
	conn.SetReadLimit(frameBytes)
	var total int64
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			job.deliver(jobEvent{code: "network", terminal: true})
			return
		}
		switch kind {
		case websocket.BinaryMessage:
			total += int64(len(data))
			if job.request.Operation != OperationAudio && total > MaxMetadataBytes {
				job.deliver(jobEvent{code: "output_limit", terminal: true})
				return
			}
			if len(data) > 0 && !job.deliver(jobEvent{data: data}) {
				return
			}
		case websocket.TextMessage:
			var result wireMessage
			if len(data) > 1024 || json.Unmarshal(data, &result) != nil || result.Type != "result" {
				job.deliver(jobEvent{code: "unknown", terminal: true})
				return
			}
			code := result.Code
			if code != "" {
				code = safeCode(code)
			}
			job.deliver(jobEvent{code: code, terminal: true})
			return
		default:
			job.deliver(jobEvent{code: "unknown", terminal: true})
			return
		}
	}
}

// Audio travels worker -> broker and can intentionally stop under backpressure.
// Keep the reverse direction active for proxies without requiring a worker
// response, which could otherwise queue behind its blocked audio writer.
func keepJobAlive(job *brokerJob, conn *websocket.Conn, done <-chan struct{}, interval time.Duration) {
	if interval <= 0 {
		interval = heartbeatInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-job.ctx.Done():
			return
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if conn.WriteMessage(websocket.TextMessage, []byte(jobKeepaliveMessage)) != nil {
				job.cancel()
				_ = conn.Close()
				return
			}
		}
	}
}

func (j *brokerJob) deliver(event jobEvent) bool {
	select {
	case j.events <- event:
		return true
	case <-j.ctx.Done():
		return false
	}
}

func (b *Broker) reserve(ctx context.Context, request Request) (*brokerJob, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.session == nil || !b.session.ready {
		return nil, &Error{Code: "offline"}
	}
	audio := request.Operation == OperationAudio
	if (audio && b.audioBusy) || (!audio && b.metadataBusy) {
		return nil, &Error{Code: "busy"}
	}
	ctx, cancel := context.WithCancel(ctx)
	job := &brokerJob{id: randomID(), session: b.session, request: request, ctx: ctx, cancel: cancel, attached: make(chan struct{}), events: make(chan jobEvent, 1)}
	b.jobs[job.id] = job
	if audio {
		b.audioBusy = true
	} else {
		b.metadataBusy = true
	}
	return job, nil
}

func (b *Broker) release(job *brokerJob) {
	job.cancel()
	b.mu.Lock()
	if job.conn != nil {
		_ = job.conn.Close()
	}
	delete(b.jobs, job.id)
	if job.request.Operation == OperationAudio {
		b.audioBusy = false
	} else {
		b.metadataBusy = false
	}
	b.mu.Unlock()
}

func writeError(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	status := http.StatusBadGateway
	if code == "invalid_request" {
		status = http.StatusBadRequest
	}
	if code == "offline" || code == "busy" {
		status = http.StatusServiceUnavailable
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(&Error{Code: safeCode(code)})
}

func (b *Broker) ExecutorHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/run" {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, controlBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		writeError(w, "invalid_request")
		return
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(w, "invalid_request")
		return
	}
	if err := request.validate(); err != nil {
		writeError(w, "invalid_request")
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	// A cancellation deadline must never affect a reused private connection.
	w.Header().Set("Connection", "close")
	job, err := b.reserve(r.Context(), request)
	if err != nil {
		writeError(w, errorCode(err))
		return
	}
	defer b.release(job)
	// Paused playback can fill the HTTP socket and block Write. A lost worker
	// must release that reservation without waiting for the listener to resume.
	stopInterrupt := context.AfterFunc(job.ctx, func() {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
	})
	defer stopInterrupt()
	if job.session.send(wireMessage{Type: "job", ID: job.id, Request: &request}) != nil {
		writeError(w, "network")
		return
	}
	timer := time.NewTimer(attachTimeout)
	defer timer.Stop()
	select {
	case <-job.attached:
	case <-job.ctx.Done():
		writeError(w, "network")
		return
	case <-timer.C:
		writeError(w, "network")
		return
	}
	var metadata bytes.Buffer
	audio := request.Operation == OperationAudio
	started := false
	for {
		select {
		case <-job.ctx.Done():
			if started {
				w.Header().Set(jobErrorTrailer, "network")
			} else {
				writeError(w, "network")
			}
			return
		case event := <-job.events:
			if event.terminal {
				if event.code != "" {
					if started {
						w.Header().Set(jobErrorTrailer, event.code)
					} else {
						writeError(w, event.code)
					}
					return
				}
				if !audio {
					w.Header().Set("Content-Type", "application/octet-stream")
					_, _ = w.Write(metadata.Bytes())
				}
				return
			}
			if !audio {
				_, _ = metadata.Write(event.data)
				continue
			}
			if !started {
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("Trailer", jobErrorTrailer)
				started = true
			}
			if _, err := w.Write(event.data); err != nil {
				return
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				return
			}
		}
	}
}

// Close explicitly tears down hijacked sockets, which http.Server.Shutdown does
// not close. It is safe to call more than once.
func (b *Broker) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	if b.session != nil {
		b.session.stop()
		b.session = nil
	}
	for _, job := range b.jobs {
		job.cancel()
		if job.conn != nil {
			_ = job.conn.Close()
		}
	}
	return nil
}
