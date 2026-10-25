package musicworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testToken = "test-only-worker-token-0123456789abcdef"

type testSystem struct {
	broker     *Broker
	server     *httptest.Server
	cancel     context.CancelFunc
	workerDone chan error
}

func newTestSystem(t *testing.T, runner Runner) *testSystem {
	t.Helper()
	b, err := NewBroker(testToken)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc(ControlPath, b.ControlHandler)
	mux.HandleFunc(JobPath, b.JobHandler)
	mux.HandleFunc("/run", b.ExecutorHandler)
	server := httptest.NewUnstartedServer(mux)
	// Production listener has deadlines; successful upgrades must clear them.
	server.Config.ReadTimeout = 100 * time.Millisecond
	server.Config.WriteTimeout = 100 * time.Millisecond
	server.Start()
	ctx, cancel := context.WithCancel(context.Background())
	s := &testSystem{broker: b, server: server, cancel: cancel, workerDone: make(chan error, 1)}
	if runner != nil {
		go func() {
			s.workerDone <- RunWorker(ctx, WorkerConfig{Endpoint: server.URL, Token: testToken, ReconnectDelay: 10 * time.Millisecond}, runner)
		}()
		waitFor(t, func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.session != nil && b.session.ready })
	}
	t.Cleanup(func() {
		cancel()
		_ = b.Close()
		server.Close()
		if runner != nil {
			select {
			case <-s.workerDone:
			case <-time.After(3 * time.Second):
				t.Error("worker failed to stop")
			}
		}
	})
	return s
}

func waitFor(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func (s *testSystem) execute(ctx context.Context, request Request, writer io.Writer) error {
	return executeHTTP(ctx, s.server.Client(), s.server.URL+"/run", request, writer)
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("error=%v, want code %q", err, code)
	}
}

func TestRoundTripIndependentJobStreams(t *testing.T) {
	for _, operation := range []string{OperationMetadata, OperationSearch, OperationAudio} {
		t.Run(operation, func(t *testing.T) {
			payload := bytes.Repeat([]byte("music-payload-"), frameBytes/2)
			s := newTestSystem(t, func(ctx context.Context, req Request, writer io.Writer) error {
				if req.Operation != operation || req.Input != "https://www.youtube.com/watch?v=0KbRhUtFwkc" {
					return errors.New("unexpected request")
				}
				// Exceeds the outer HTTP listener timeout, including first output.
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(150 * time.Millisecond):
				}
				_, err := writer.Write(payload)
				return err
			})
			var output bytes.Buffer
			if err := s.execute(context.Background(), Request{Operation: operation, Input: "https://www.youtube.com/watch?v=0KbRhUtFwkc"}, &output); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(output.Bytes(), payload) {
				t.Fatalf("output length=%d, want %d", output.Len(), len(payload))
			}
		})
	}
}

func TestMetadataFailureIsAtomicAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"provider", &Error{Code: "bot_check"}, "bot_check"},
		{"untyped", errors.New("secret-cookie-value and private URL"), "unknown"},
		{"unlisted", &Error{Code: "secret-cookie-value"}, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestSystem(t, func(_ context.Context, _ Request, out io.Writer) error {
				_, _ = io.WriteString(out, "partial-private-result")
				return tc.err
			})
			var output bytes.Buffer
			requireCode(t, s.execute(context.Background(), Request{Operation: OperationMetadata, Input: "url"}, &output), tc.code)
			if output.Len() != 0 {
				t.Fatal("failed metadata was partially returned")
			}
		})
	}
}

func TestAudioPreservesTerminalError(t *testing.T) {
	s := newTestSystem(t, func(_ context.Context, _ Request, out io.Writer) error {
		_, _ = io.WriteString(out, "audio-prefix")
		return &Error{Code: "network"}
	})
	var output bytes.Buffer
	requireCode(t, s.execute(context.Background(), Request{Operation: OperationAudio, Input: "url"}, &output), "network")
	if output.String() != "audio-prefix" {
		t.Fatalf("output=%q", output.String())
	}
}

func TestMetadataSizeIsBoundedWithoutPartialSuccess(t *testing.T) {
	s := newTestSystem(t, func(_ context.Context, _ Request, out io.Writer) error {
		chunk := make([]byte, frameBytes)
		for i := 0; i < MaxMetadataBytes/frameBytes+1; i++ {
			if _, err := out.Write(chunk); err != nil {
				return err
			}
		}
		return nil
	})
	var output bytes.Buffer
	requireCode(t, s.execute(context.Background(), Request{Operation: OperationMetadata, Input: "url"}, &output), "output_limit")
	if output.Len() != 0 {
		t.Fatal("oversized metadata returned partial success")
	}
}

func TestOfflineAndRequestValidation(t *testing.T) {
	s := newTestSystem(t, nil)
	requireCode(t, s.execute(context.Background(), Request{Operation: OperationMetadata, Input: "url"}, io.Discard), "offline")
	for _, request := range []Request{
		{Operation: "exec", Input: "whoami"},
		{Operation: OperationAudio, Input: "\nmalformed"},
		{Operation: OperationAudio, Input: strings.Repeat("x", 4097)},
		{Operation: OperationAudio, Input: "url", SeekSeconds: -1},
		{Operation: OperationMetadata, Input: "url", SeekSeconds: 1},
	} {
		requireCode(t, s.execute(context.Background(), request, io.Discard), "invalid_request")
	}
	for _, body := range []string{`{"operation":"audio","input":"url","argv":["whoami"]}`, `{"operation":"audio","input":"url"} {}`, strings.Repeat("x", controlBytes+1)} {
		resp, err := s.server.Client().Post(s.server.URL+"/run", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status=%d", resp.StatusCode)
		}
	}
}

func TestWorkerAuthenticationAndOrigin(t *testing.T) {
	s := newTestSystem(t, nil)
	for _, path := range []string{ControlPath, JobPath + "?id=unknown"} {
		for _, headers := range []http.Header{nil, {"Authorization": []string{"Bearer wrong"}}, {"Authorization": []string{"Bearer " + testToken}, "Origin": []string{"https://example.com"}}} {
			conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.server.URL, "http")+path, headers)
			if conn != nil {
				conn.Close()
				t.Fatal("unauthorized socket accepted")
			}
			if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("unexpected auth response: %v %+v", err, resp)
			}
			if resp.Body != nil {
				resp.Body.Close()
			}
		}
	}
	if _, err := NewBroker("short"); err == nil {
		t.Fatal("short token accepted")
	}
	for _, endpoint := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?secret=x"} {
		if _, _, err := workerURLs(endpoint); err == nil {
			t.Fatalf("invalid endpoint %s accepted", endpoint)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	requireCode(t, RunWorker(ctx, WorkerConfig{Endpoint: s.server.URL, Token: strings.Repeat("x", 32)}, func(context.Context, Request, io.Writer) error { return nil }), "forbidden")
}

func TestOneAudioAndOneMetadataSlot(t *testing.T) {
	started := make(chan string, 4)
	canceled := make(chan string, 4)
	s := newTestSystem(t, func(ctx context.Context, req Request, _ io.Writer) error {
		started <- req.Operation
		<-ctx.Done()
		canceled <- req.Operation
		return ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 2)
	for _, op := range []string{OperationAudio, OperationMetadata} {
		go func(op string) { done <- s.execute(ctx, Request{Operation: op, Input: "url"}, io.Discard) }(op)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("job not started")
		}
	}
	for _, op := range []string{OperationAudio, OperationSearch} {
		requireCode(t, s.execute(context.Background(), Request{Operation: op, Input: "url"}, io.Discard), "busy")
	}
	cancel()
	for i := 0; i < 2; i++ {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("runner did not cancel")
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("request did not cancel")
		}
	}
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return len(s.broker.jobs) == 0 && !s.broker.audioBusy && !s.broker.metadataBusy
	})
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("broken pipe") }

func TestOutputFailureCancelsRemoteRunner(t *testing.T) {
	stopped := make(chan struct{})
	s := newTestSystem(t, func(ctx context.Context, _ Request, out io.Writer) error {
		defer close(stopped)
		chunk := make([]byte, frameBytes)
		for {
			if _, err := out.Write(chunk); err != nil {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
		}
	})
	if err := s.execute(context.Background(), Request{Operation: OperationAudio, Input: "url"}, failingWriter{}); err == nil {
		t.Fatal("output failure ignored")
	}
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("remote runner remained alive after pipe closed")
	}
}

func TestControlDisconnectCancelsJobsAndReconnects(t *testing.T) {
	started := make(chan struct{}, 1)
	stopped := make(chan struct{}, 1)
	s := newTestSystem(t, func(ctx context.Context, req Request, out io.Writer) error {
		if req.Input == "hold" {
			started <- struct{}{}
			<-ctx.Done()
			stopped <- struct{}{}
			return ctx.Err()
		}
		_, err := io.WriteString(out, "ready")
		return err
	})
	done := make(chan error, 1)
	go func() {
		done <- s.execute(context.Background(), Request{Operation: OperationAudio, Input: "hold"}, io.Discard)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("job not started")
	}
	s.broker.mu.Lock()
	old := s.broker.session
	_ = old.conn.Close()
	s.broker.mu.Unlock()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("runner survived control disconnect")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("disconnected stream succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("request did not end")
	}
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return s.broker.session != nil && s.broker.session != old && len(s.broker.jobs) == 0
	})
	var output bytes.Buffer
	if err := s.execute(context.Background(), Request{Operation: OperationMetadata, Input: "ok"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "ready" {
		t.Fatal("reconnected worker returned wrong data")
	}
}

// This writer models a paused consumer whose socket buffers are full. The only
// way for Write to return is the broker applying its cancellation deadline.
type pausedResponse struct {
	headers      http.Header
	entered      chan struct{}
	unblock      chan struct{}
	once         sync.Once
	deadlineOnce sync.Once
}

func (p *pausedResponse) Header() http.Header { return p.headers }
func (p *pausedResponse) WriteHeader(int)     {}
func (p *pausedResponse) Write([]byte) (int, error) {
	p.once.Do(func() { close(p.entered) })
	<-p.unblock
	return 0, errors.New("write deadline")
}
func (p *pausedResponse) FlushError() error { return nil }
func (p *pausedResponse) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		p.deadlineOnce.Do(func() { close(p.unblock) })
	}
	return nil
}

func TestCloseInterruptsPausedHTTPWriteAndReleasesSlot(t *testing.T) {
	stopped := make(chan struct{})
	s := newTestSystem(t, func(ctx context.Context, _ Request, out io.Writer) error {
		defer close(stopped)
		if _, err := io.WriteString(out, "audio"); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	})
	s.broker.mu.Lock()
	s.broker.jobKeepaliveInterval = 5 * time.Millisecond
	s.broker.mu.Unlock()
	body, _ := json.Marshal(Request{Operation: OperationAudio, Input: "url"})
	request := httptest.NewRequest(http.MethodPost, "http://private/run", bytes.NewReader(body))
	response := &pausedResponse{headers: make(http.Header), entered: make(chan struct{}), unblock: make(chan struct{})}
	done := make(chan struct{})
	go func() { s.broker.ExecutorHandler(response, request); close(done) }()
	select {
	case <-response.entered:
	case <-time.After(time.Second):
		t.Fatal("audio Write not reached")
	}
	// Several fixed job keepalives arrive while the HTTP consumer is paused.
	// The worker must accept them without canceling or needing to write a pong.
	select {
	case <-stopped:
		t.Fatal("worker treated a keepalive as cancellation")
	case <-time.After(40 * time.Millisecond):
	}
	_ = s.broker.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("paused HTTP write did not stop")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("paused remote runner did not stop")
	}
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	if s.broker.audioBusy || len(s.broker.jobs) != 0 {
		t.Fatal("paused job reservation leaked")
	}
}

type resumableResponse struct {
	headers   http.Header
	entered   chan struct{}
	resume    chan struct{}
	abort     chan struct{}
	enterOnce sync.Once
	abortOnce sync.Once
	written   atomic.Int64
}

func (p *resumableResponse) Header() http.Header { return p.headers }
func (p *resumableResponse) WriteHeader(int)     {}
func (p *resumableResponse) Write(data []byte) (int, error) {
	p.enterOnce.Do(func() { close(p.entered) })
	select {
	case <-p.resume:
	case <-p.abort:
		return 0, errors.New("write canceled")
	}
	p.written.Add(int64(len(data)))
	return len(data), nil
}
func (p *resumableResponse) FlushError() error { return nil }
func (p *resumableResponse) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		p.abortOnce.Do(func() { close(p.abort) })
	}
	return nil
}

func TestJobKeepaliveFlowsDuringBackpressureAndAudioResumes(t *testing.T) {
	s := newTestSystem(t, nil)
	s.broker.mu.Lock()
	s.broker.jobKeepaliveInterval = 5 * time.Millisecond
	s.broker.mu.Unlock()
	control, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.server.URL, "http")+ControlPath, http.Header{"Authorization": []string{"Bearer " + testToken}})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	var hello wireMessage
	if err := control.ReadJSON(&hello); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return s.broker.session != nil && s.broker.session.ready
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body, _ := json.Marshal(Request{Operation: OperationAudio, Input: "url"})
	request := httptest.NewRequest(http.MethodPost, "http://private/run", bytes.NewReader(body)).WithContext(ctx)
	response := &resumableResponse{headers: make(http.Header), entered: make(chan struct{}), resume: make(chan struct{}), abort: make(chan struct{})}
	executorDone := make(chan struct{})
	go func() { s.broker.ExecutorHandler(response, request); close(executorDone) }()
	var assignment wireMessage
	if err := control.ReadJSON(&assignment); err != nil {
		t.Fatal(err)
	}
	endpoint := "ws" + strings.TrimPrefix(s.server.URL, "http") + JobPath + "?id=" + assignment.ID
	job, _, err := websocket.DefaultDialer.Dial(endpoint, http.Header{"Authorization": []string{"Bearer " + testToken}, sessionHeader: []string{hello.Session}})
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	keepalives := make(chan struct{}, 128)
	readerDone := make(chan error, 1)
	go func() {
		for {
			kind, data, err := job.ReadMessage()
			if err != nil {
				readerDone <- nil
				return
			}
			if kind != websocket.TextMessage || string(data) != jobKeepaliveMessage {
				readerDone <- errors.New("unexpected job keepalive frame")
				return
			}
			select {
			case keepalives <- struct{}{}:
			default:
			}
		}
	}()
	const frameCount = 1024
	var sent atomic.Int64
	writerDone := make(chan error, 1)
	go func() {
		chunk := make([]byte, frameBytes)
		for i := 0; i < frameCount; i++ {
			if err := job.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				writerDone <- err
				return
			}
			sent.Add(frameBytes)
		}
		writerDone <- job.WriteJSON(wireMessage{Type: "result"})
	}()
	select {
	case <-response.entered:
	case <-time.After(time.Second):
		t.Fatal("HTTP write never paused")
	}
	for i := 0; i < 3; i++ {
		select {
		case <-keepalives:
		case err := <-readerDone:
			t.Fatalf("job closed while paused: %v", err)
		case <-time.After(time.Second):
			t.Fatal("no keepalive during pause")
		}
	}
	// Wait for TCP buffers to fill; server-to-worker heartbeats must continue
	// while the worker-to-server media Write is actually blocked.
	lastSent, stableSince := sent.Load(), time.Now()
	waitFor(t, func() bool {
		current := sent.Load()
		if current != lastSent {
			lastSent = current
			stableSince = time.Now()
			return false
		}
		return time.Since(stableSince) >= 30*time.Millisecond
	})
	select {
	case err := <-writerDone:
		t.Fatalf("64 MiB audio unexpectedly finished while paused: %v", err)
	default:
	}
	select {
	case <-keepalives:
	case <-time.After(time.Second):
		t.Fatal("backpressure blocked keepalive")
	}
	close(response.resume)
	select {
	case err := <-writerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("audio did not resume")
	}
	select {
	case <-executorDone:
	case <-time.After(5 * time.Second):
		t.Fatal("executor did not finish resumed audio")
	}
	if response.written.Load() != int64(frameCount*frameBytes) {
		t.Fatal("resumed audio lost bytes")
	}
	select {
	case err := <-readerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("keepalive goroutine/socket survived job completion")
	}
}

func TestJobClaimRequiresCurrentSessionAndCannotBeReplayed(t *testing.T) {
	s := newTestSystem(t, nil)
	control, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.server.URL, "http")+ControlPath, http.Header{"Authorization": []string{"Bearer " + testToken}})
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	var hello wireMessage
	if err := control.ReadJSON(&hello); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return s.broker.session != nil && s.broker.session.ready
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.execute(ctx, Request{Operation: OperationAudio, Input: "url"}, io.Discard) }()
	var assignment wireMessage
	if err := control.ReadJSON(&assignment); err != nil {
		t.Fatal(err)
	}
	endpoint := "ws" + strings.TrimPrefix(s.server.URL, "http") + JobPath + "?id=" + assignment.ID
	for _, session := range []string{"", strings.Repeat("a", 64)} {
		conn, resp, err := websocket.DefaultDialer.Dial(endpoint, http.Header{"Authorization": []string{"Bearer " + testToken}, sessionHeader: []string{session}})
		if conn != nil {
			conn.Close()
			t.Fatal("wrong session accepted")
		}
		if err == nil || resp == nil || resp.StatusCode != http.StatusGone {
			t.Fatal("wrong session not rejected")
		}
		resp.Body.Close()
	}
	job, _, err := websocket.DefaultDialer.Dial(endpoint, http.Header{"Authorization": []string{"Bearer " + testToken}, sessionHeader: []string{hello.Session}})
	if err != nil {
		t.Fatal(err)
	}
	defer job.Close()
	replay, resp, err := websocket.DefaultDialer.Dial(endpoint, http.Header{"Authorization": []string{"Bearer " + testToken}, sessionHeader: []string{hello.Session}})
	if replay != nil {
		replay.Close()
		t.Fatal("job replay accepted")
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusGone {
		t.Fatal("job replay not rejected")
	}
	resp.Body.Close()
	if err := job.WriteJSON(wireMessage{Type: "result"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("job did not complete")
	}
}

func TestRapidSequentialJobsDoNotRaceWorkerSlots(t *testing.T) {
	s := newTestSystem(t, func(_ context.Context, req Request, out io.Writer) error {
		_, err := fmt.Fprint(out, req.Input)
		return err
	})
	for i := 0; i < 50; i++ {
		var output bytes.Buffer
		input := fmt.Sprint(i)
		if err := s.execute(context.Background(), Request{Operation: OperationMetadata, Input: input}, &output); err != nil {
			t.Fatalf("job%d: %v", i, err)
		}
		if output.String() != input {
			t.Fatal("wrong result")
		}
	}
}
