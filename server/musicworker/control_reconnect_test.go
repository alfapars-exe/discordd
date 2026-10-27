package musicworker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type recordingPausedResponse struct {
	resumableResponse
	output bytes.Buffer
}

func TestControlDisconnectCancelsUnclaimedAndRejectsOldSession(t *testing.T) {
	s := newTestSystem(t, nil)
	endpoint := "ws" + strings.TrimPrefix(s.server.URL, "http")
	header := http.Header{"Authorization": []string{"Bearer " + testToken}}
	connect := func() (*websocket.Conn, wireMessage) {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial(endpoint+ControlPath, header)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		var hello wireMessage
		if err := conn.ReadJSON(&hello); err != nil {
			t.Fatal(err)
		}
		waitFor(t, func() bool {
			s.broker.mu.Lock()
			defer s.broker.mu.Unlock()
			return s.broker.session != nil && s.broker.session.ready
		})
		return conn, hello
	}
	old, oldHello := connect()
	done := make(chan error, 1)
	go func() {
		done <- s.execute(context.Background(), Request{Operation: OperationAudio, Input: "unclaimed"}, io.Discard)
	}()
	var assignment wireMessage
	if err := old.ReadJSON(&assignment); err != nil {
		t.Fatal(err)
	}
	_ = old.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("unclaimed work succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("unclaimed work not canceled")
	}
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return s.broker.session == nil && len(s.broker.jobs) == 0 && !s.broker.audioBusy
	})
	current, hello := connect()
	go func() {
		done <- s.execute(context.Background(), Request{Operation: OperationAudio, Input: "new"}, io.Discard)
	}()
	if err := current.ReadJSON(&assignment); err != nil {
		t.Fatal(err)
	}
	jobURL := endpoint + JobPath + "?id=" + assignment.ID
	stale := header.Clone()
	stale.Set(sessionHeader, oldHello.Session)
	conn, resp, err := websocket.DefaultDialer.Dial(jobURL, stale)
	if conn != nil {
		conn.Close()
		t.Fatal("stale control session claimed new work")
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusGone {
		t.Fatal("stale session was not rejected")
	}
	resp.Body.Close()
	valid := header.Clone()
	valid.Set(sessionHeader, hello.Session)
	conn, _, err = websocket.DefaultDialer.Dial(jobURL, valid)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.WriteJSON(wireMessage{Type: "result"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("new session job did not finish")
	}
}

// The fixture deliberately bypasses broker quotas: worker resource limits must
// remain global even if a replacement control session assigns another job.
func TestWorkerQuotasAndAuthenticationAcrossReconnect(t *testing.T) {
	for _, operation := range []string{OperationAudio, OperationMetadata} {
		for _, rejectionStatus := range []int{0, http.StatusUnauthorized, http.StatusForbidden} {
			reject := rejectionStatus != 0
			name := operation + "/quota"
			if reject {
				name = fmt.Sprintf("%s/authentication-rejection-%d", operation, rejectionStatus)
			}
			t.Run(name, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				var controls atomic.Int32
				firstControl := make(chan *websocket.Conn, 1)
				secondControl := make(chan struct{})
				started := make(chan string, 2)
				stopped := make(chan string, 2)
				release := make(chan struct{})
				mux := http.NewServeMux()
				mux.HandleFunc(ControlPath, func(w http.ResponseWriter, r *http.Request) {
					n := controls.Add(1)
					if n > 1 && reject {
						http.Error(w, "unauthorized", rejectionStatus)
						return
					}
					conn, err := workerUpgrader.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer conn.Close()
					id := strings.Repeat("a", 64)
					input := "first"
					if n > 1 {
						id = strings.Repeat("b", 64)
						input = "second"
					}
					if conn.WriteJSON(wireMessage{Type: "ready", Session: id}) != nil {
						return
					}
					if conn.WriteJSON(wireMessage{Type: "job", ID: id, Request: &Request{Operation: operation, Input: input}}) != nil {
						return
					}
					switch n {
					case 1:
						firstControl <- conn
					case 2:
						close(secondControl)
					}
					_, _, _ = conn.ReadMessage()
				})
				mux.HandleFunc(JobPath, func(w http.ResponseWriter, r *http.Request) {
					conn, err := workerUpgrader.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer conn.Close()
					for {
						kind, _, err := conn.ReadMessage()
						if err != nil || kind == websocket.TextMessage {
							return
						}
					}
				})
				server := httptest.NewServer(mux)
				defer server.Close()
				done := make(chan error, 1)
				go func() {
					done <- RunWorker(ctx, WorkerConfig{Endpoint: server.URL, Token: testToken, ReconnectDelay: time.Millisecond}, func(ctx context.Context, req Request, out io.Writer) error {
						started <- req.Input
						defer func() { stopped <- req.Input }()
						if req.Input == "first" {
							select {
							case <-release:
							case <-ctx.Done():
								return ctx.Err()
							}
						}
						_, err := io.WriteString(out, "payload")
						return err
					})
				}()
				t.Cleanup(func() {
					cancel()
					select {
					case err := <-done:
						if reject {
							requireCode(t, err, "forbidden")
						}
					case <-time.After(time.Second):
						t.Error("worker shutdown leaked")
					}
				})
				select {
				case <-started:
				case <-time.After(time.Second):
					t.Fatal("first runner absent")
				}
				(<-firstControl).Close()
				if reject {
					select {
					case <-stopped:
					case <-time.After(time.Second):
						t.Fatal("auth rejection did not cancel old job")
					}
					// Cleanup checks that RunWorker has also finished draining jobs.
					return
				}
				select {
				case <-secondControl:
				case <-time.After(time.Second):
					t.Fatal("worker did not reconnect")
				}
				select {
				case id := <-started:
					t.Fatalf("quota reset on reconnect: %s", id)
				case <-time.After(40 * time.Millisecond):
				}
				select {
				case <-stopped:
					t.Fatal("control reconnect canceled active runner")
				default:
				}
				close(release)
				select {
				case id := <-started:
					if id != "second" {
						t.Fatal(id)
					}
				case <-time.After(time.Second):
					t.Fatal("quota did not release")
				}
			})
		}
	}
}

func TestReconnectedPausedStreamStillCancels(t *testing.T) {
	for _, reason := range []string{"caller", "worker-parent", "broker-shutdown", "data-socket"} {
		t.Run(reason, func(t *testing.T) {
			stopped := make(chan struct{})
			s := newTestSystem(t, func(ctx context.Context, _ Request, out io.Writer) error {
				defer close(stopped)
				if _, err := io.WriteString(out, "audio"); err != nil {
					return err
				}
				<-ctx.Done()
				return ctx.Err()
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			body, _ := json.Marshal(Request{Operation: OperationAudio, Input: "url"})
			req := httptest.NewRequest(http.MethodPost, "http://private/run", bytes.NewReader(body)).WithContext(ctx)
			response := &resumableResponse{headers: make(http.Header), entered: make(chan struct{}), resume: make(chan struct{}), abort: make(chan struct{})}
			done := make(chan struct{})
			go func() { s.broker.ExecutorHandler(response, req); close(done) }()
			select {
			case <-response.entered:
			case <-time.After(time.Second):
				t.Fatal("consumer not paused")
			}
			s.broker.mu.Lock()
			old := s.broker.session
			_ = old.conn.Close()
			s.broker.mu.Unlock()
			waitFor(t, func() bool {
				s.broker.mu.Lock()
				defer s.broker.mu.Unlock()
				return s.broker.session != nil && s.broker.session != old && s.broker.session.ready
			})
			switch reason {
			case "caller":
				cancel()
			case "worker-parent":
				s.cancel()
			case "broker-shutdown":
				_ = s.broker.Close()
			case "data-socket":
				s.broker.mu.Lock()
				for _, job := range s.broker.jobs {
					_ = job.conn.Close()
				}
				s.broker.mu.Unlock()
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("paused HTTP consumer was not interrupted")
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("runner was not canceled")
			}
			waitFor(t, func() bool {
				s.broker.mu.Lock()
				defer s.broker.mu.Unlock()
				return len(s.broker.jobs) == 0 && !s.broker.audioBusy
			})
		})
	}
}

func (p *recordingPausedResponse) Write(data []byte) (int, error) {
	if _, err := p.resumableResponse.Write(data); err != nil {
		return 0, err
	}
	return p.output.Write(data)
}

func TestCompletedAudioDrainSurvivesControlReconnect(t *testing.T) {
	payload := bytes.Repeat([]byte("audio-drain-payload"), 16384)
	produced := make(chan struct{})
	s := newTestSystem(t, func(ctx context.Context, _ Request, out io.Writer) error {
		_, err := out.Write(payload)
		close(produced)
		return err
	})
	body, _ := json.Marshal(Request{Operation: OperationAudio, Input: "url"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "http://private/run", bytes.NewReader(body)).WithContext(ctx)
	response := &recordingPausedResponse{resumableResponse: resumableResponse{headers: make(http.Header), entered: make(chan struct{}), resume: make(chan struct{}), abort: make(chan struct{})}}
	done := make(chan struct{})
	go func() { s.broker.ExecutorHandler(response, req); close(done) }()
	select {
	case <-response.entered:
	case <-ctx.Done():
		t.Fatal("consumer never paused")
	}
	select {
	case <-produced:
	case <-ctx.Done():
		t.Fatal("producer did not finish before disconnect")
	}
	s.broker.mu.Lock()
	old := s.broker.session
	_ = old.conn.Close()
	s.broker.mu.Unlock()
	waitFor(t, func() bool {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()
		return s.broker.session != nil && s.broker.session != old && s.broker.session.ready
	})
	select {
	case <-response.abort:
		t.Fatal("control reconnect canceled completed audio drain")
	default:
	}
	close(response.resume)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("resumed drain did not complete")
	}
	if !bytes.Equal(response.output.Bytes(), payload) {
		t.Fatalf("audio corrupted: got %d bytes, want %d", response.output.Len(), len(payload))
	}
	if got := response.Header().Get(jobErrorTrailer); got != "" {
		t.Fatalf("terminal error: %s", got)
	}
}
