package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestConfigRejectsMalformedBaseWithoutPanic(t *testing.T) {
	for _, base := range []string{"", "h", "ftp://localhost", "http://", "http://user:opaque@localhost", "https://localhost/?query=value", "https://localhost/#fragment"} {
		if _, err := parseConfig(base, "fixture-token", "server", "channel"); err == nil {
			t.Errorf("invalid base accepted: %q", base)
		}
	}
	config, err := parseConfig("https://example.test/prefix/", "fixture-token", "server", "channel")
	if err != nil || config.gateway != "wss://example.test/prefix/api/bot/gateway" {
		t.Fatalf("gateway conversion: %q, %v", config.gateway, err)
	}
}

func TestMessageStatusAndWireContract(t *testing.T) {
	for _, status := range []int{201, 401, 403, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/servers/server/channels/channel/messages" || r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error("message request changed its REST contract")
				}
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["content"] != "welcome" {
					t.Error("message body changed")
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			config, _ := parseConfig(server.URL, "fixture-token", "server", "channel")
			err := postMessage(context.Background(), server.Client(), config, "welcome")
			if (err == nil) != (status == 201) {
				t.Fatalf("HTTP %d reported as success=%v", status, err == nil)
			}
		})
	}
}

func TestMessageCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	config, _ := parseConfig("http://127.0.0.1", "fixture-token", "server", "channel")
	if err := postMessage(ctx, &http.Client{Timeout: time.Second}, config, "welcome"); err == nil {
		t.Fatal("canceled request succeeded")
	}
}

func TestWelcomeUsesUsernameWhenDisplayNameIsAbsent(t *testing.T) {
	join := event{Op: "member_join", ServerID: "server", Data: json.RawMessage(`{"id":"id","username":"handle"}`)}
	if text, ok := join.welcomeText("server"); !ok || text != "Aramiza hos geldin, @handle!" {
		t.Fatalf("unexpected welcome %q, accepted=%t", text, ok)
	}
}

func TestMessageTimesOutWaitingForResponse(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release)
	client := server.Client()
	client.Timeout = 100 * time.Millisecond
	config, err := parseConfig(server.URL, "fixture-token", "server", "channel")
	if err != nil {
		t.Fatal(err)
	}
	if err := postMessage(context.Background(), client, config, "welcome"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected message timeout, got %v", err)
	}
}

func TestGatewayFiltersServerAndStopsOnCancellation(t *testing.T) {
	posted := make(chan string, 2)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/bot/gateway" {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			posted <- body["content"]
			w.WriteHeader(http.StatusCreated)
			return
		}
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		for _, payload := range []string{
			`{"op":"member_join","d":{"id":"id","username":"unscoped"}}`,
			`{"op":"member_join","server_id":"other","d":{"id":"id","username":"ignored"}}`,
			`{"op":"member_join","server_id":"server","d":"invalid"}`,
			`{"op":"member_join","server_id":"server","d":{"id":"id","username":"handle","display_name":"Display"}}`,
		} {
			_ = connection.WriteMessage(websocket.TextMessage, []byte(payload))
		}
		_, _, _ = connection.ReadMessage()
	}))
	defer server.Close()
	config, _ := parseConfig(server.URL, "fixture-token", "server", "channel")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGateway(ctx, config, websocket.DefaultDialer, server.Client(), time.Minute) }()
	select {
	case message := <-posted:
		if !strings.Contains(message, "@Display") {
			t.Errorf("wrong welcome: %q", message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("matching join was not delivered")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("gateway retained its socket after cancellation")
	}
	if len(posted) != 0 {
		t.Fatal("unrelated or malformed joins were posted")
	}
}

func TestSilentGatewayReleasesReadForReconnect(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()
	config, err := parseConfig(server.URL, "fixture-token", "server", "channel")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = runGateway(ctx, config, websocket.DefaultDialer, server.Client(), 100*time.Millisecond)
	var timeout net.Error
	if ctx.Err() != nil || !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatalf("silent gateway failed to time out before cancellation: %v", err)
	}
}

func TestGatewayPingsKeepIdleBotConnected(t *testing.T) {
	upgrader := websocket.Upgrader{}
	const idle = 300 * time.Millisecond
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for i := 0; i < 6; i++ {
			time.Sleep(idle / 4)
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(idle)); err != nil {
				return
			}
		}
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "complete"), time.Now().Add(idle))
		_ = conn.SetReadDeadline(time.Now().Add(idle))
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()
	config, err := parseConfig(server.URL, "fixture-token", "server", "channel")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err = runGateway(ctx, config, websocket.DefaultDialer, server.Client(), idle)
	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("healthy idle connection ended before the gateway closed it: %v", err)
	}
}
func TestWelcomeRejectsRedirectToAnotherPort(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("redirect forwarded message, authorization present=%t", r.Header.Get("Authorization") != "")
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	config, _ := parseConfig(origin.URL, "fixture-token", "server", "channel")
	if postMessage(context.Background(), newMessageClient(), config, "welcome") == nil {
		t.Fatal("cross-origin redirect reported success")
	}
}

func TestWelcomeRedirectPreservesPost(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/inbox", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error("received redirected request without authenticated POST")
				}
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["content"] != "welcome" {
					t.Error("redirected request lost welcome message")
				}
				w.WriteHeader(http.StatusCreated)
			})
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "/inbox", status)
			})
			server := httptest.NewServer(mux)
			defer server.Close()
			config, _ := parseConfig(server.URL, "fixture-token", "server", "channel")
			err := postMessage(context.Background(), newMessageClient(), config, "welcome")
			if (err == nil) != (status == 307 || status == 308) {
				t.Fatalf("unexpected redirect result: %v", err)
			}
		})
	}
}
