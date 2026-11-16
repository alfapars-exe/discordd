package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestConfigRejectsNonFixtureTargetsAndInvalidBounds(t *testing.T) {
	for _, base := range []string{"https://example.test", "http://localhost:9090", "http://127.0.0.1/other",
		"http://user:pass@127.0.0.1", "http://127.0.0.1?token=private", "http://127.0.0.1/#fragment",
		"http://127.0.0.1?", "http://127.0.0.1#", "file:///tmp/fixture"} {
		t.Run(base, func(t *testing.T) {
			if validateConfig(probeConfig{BaseURL: base, AccessToken: "fixture", HoldSeconds: 1}) == nil {
				t.Fatal("non-fixture target accepted")
			}
		})
	}
	for _, config := range []probeConfig{
		{BaseURL: "http://127.0.0.1", HoldSeconds: 1},
		{BaseURL: "http://127.0.0.1", AccessToken: "fixture", HoldSeconds: 0},
		{BaseURL: "http://127.0.0.1", AccessToken: "fixture", HoldSeconds: 901},
		{BaseURL: "http://127.0.0.1", AccessToken: "line\nbreak", HoldSeconds: 1},
	} {
		if validateConfig(config) == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestConfigInputIsBoundedAndRejectsUnknownOrTrailingData(t *testing.T) {
	valid := `{"base_url":"http://127.0.0.1:9090","access_token":"fixture-only","hold_seconds":720}`
	if _, err := readConfig(strings.NewReader(valid)); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{valid + `{}`, strings.Replace(valid, "720", "720,\"unknown\":1", 1), strings.Repeat(" ", 16*1024+1), `{`} {
		if _, err := readConfig(strings.NewReader(data)); err == nil || err.Error() != "invalid_config" {
			t.Fatalf("malformed configuration error=%v", err)
		}
	}
}

func TestTicketUsesRealEnvelopeAndNeverFollowsRedirect(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"valid", `{"success":true,"data":{"ticket":"fixture-one-use"}}`, 200},
		{"rejected", `{"success":false,"error":"private"}`, 200},
		{"missing", `{"success":true,"data":{}}`, 200},
		{"unauthorized", `private-response`, 401},
		{"oversized", strings.Repeat("x", 8193), 200},
		{"redirect", ``, 302},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/auth/ws-ticket" || r.Header.Get("Authorization") != "Bearer fixture-access" {
					t.Error("incorrect ticket request")
				}
				if tc.status == 302 {
					w.Header().Set("Location", target.URL)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			ticket, err := issueTicket(context.Background(), probeConfig{BaseURL: server.URL, AccessToken: "fixture-access"})
			if tc.name == "valid" {
				if err != nil || ticket != "fixture-one-use" {
					t.Fatalf("ticket=%q err=%v", ticket, err)
				}
			} else if err == nil || err.Error() != "ticket_rejected" {
				t.Fatalf("rejection=%v", err)
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("ticket redirect forwarded credentials")
	}
}

func TestProbeKeepsServerReaderLiveWithoutReadingOutput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	fixture := &probeTestPeer{t: t, cancel: cancel, joined: make(chan struct{})}
	server := httptest.NewServer(fixture)
	defer server.Close()
	var output bytes.Buffer
	if err := runProbe(ctx, probeConfig{BaseURL: server.URL, AccessToken: "private-fixture-token", HoldSeconds: 10}, &output); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fixture.joined:
	case <-time.After(3 * time.Second):
		t.Fatal("probe connection survived cancellation")
	}
	if fixture.pongs.Load() != 1 {
		t.Fatalf("protocol pongs=%d", fixture.pongs.Load())
	}
	if fixture.echoedPing.Load() != 0 {
		t.Fatal("probe drained output and automatically answered the server ping")
	}
	events := readProbeEvents(t, output.Bytes())
	if len(events) != 2 || events[0].Event != "connected" || events[1].Reason != "cancelled" || events[1].KeepalivePairs != 1 || events[0].PostUpgradeReader || events[0].ReceiveBufferRequested != 1024 {
		t.Fatalf("probe events=%+v", events)
	}
	if strings.Contains(output.String(), "private-fixture-token") || strings.Contains(output.String(), "fixture-one-use") {
		t.Fatal("probe output leaked credential")
	}
}

func readProbeEvents(t *testing.T, data []byte) []probeEvent {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	var events []probeEvent
	for {
		var event probeEvent
		err := decoder.Decode(&event)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

type probeTestPeer struct {
	t                 *testing.T
	cancel            context.CancelFunc
	pongs, echoedPing atomic.Int32
	joined            chan struct{}
}

func (s *probeTestPeer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	if r.URL.Path == "/api/auth/ws-ticket" {
		_, _ = io.WriteString(w, `{"success":true,"data":{"ticket":"fixture-one-use"}}`)
		return
	}
	if r.URL.Path != "/ws" || r.URL.Query().Get("ticket") != "fixture-one-use" {
		http.Error(w, "bad fixture", 400)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.t.Errorf("upgrade: %v", err)
		return
	}
	defer close(s.joined)
	defer conn.Close()
	s.observe(conn)
}

func (s *probeTestPeer) observe(conn *websocket.Conn) {
	conn.SetPongHandler(func(payload string) error {
		if payload == "read-loop-check" {
			s.echoedPing.Add(1)
		} else {
			s.pongs.Add(1)
		}
		return nil
	})
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var event struct {
		Op string `json:"op"`
	}
	if err := conn.ReadJSON(&event); err != nil || event.Op != "heartbeat" {
		s.t.Errorf("keepalive=%+v err=%v", event, err)
	}
	if err := conn.WriteControl(websocket.PingMessage, []byte("read-loop-check"), time.Now().Add(time.Second)); err != nil {
		s.t.Errorf("ping: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"fixture-output"}`)); err != nil {
		s.t.Errorf("output: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	_, _, _ = conn.ReadMessage()
	s.cancel()
}
