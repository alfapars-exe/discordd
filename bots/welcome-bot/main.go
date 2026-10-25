// Welcome bot demonstrates the bot gateway and server-scoped message API.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

type event struct {
	Op       string          `json:"op"`
	Data     json.RawMessage `json:"d"`
	ServerID string          `json:"server_id"`
}

type memberJoin struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
}

func (m memberJoin) name() string {
	if m.DisplayName != nil && *m.DisplayName != "" {
		return *m.DisplayName
	}
	return m.Username
}

type botConfig struct {
	base    string
	gateway string
	token   string
	server  string
	channel string
}

func parseConfig(base, token, server, channel string) (botConfig, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return botConfig{}, fmt.Errorf("HICHAT_BASE must be an HTTP(S) base URL without credentials, query or fragment")
	}
	if token == "" || server == "" || channel == "" {
		return botConfig{}, fmt.Errorf("BOT_TOKEN, WELCOME_SERVER and WELCOME_CHANNEL are required")
	}
	gateway := *parsed
	if parsed.Scheme == "https" {
		gateway.Scheme = "wss"
	} else {
		gateway.Scheme = "ws"
	}
	gateway.Path = strings.TrimRight(gateway.Path, "/") + "/api/bot/gateway"
	return botConfig{base: strings.TrimRight(parsed.String(), "/"), gateway: gateway.String(), token: token, server: server, channel: channel}, nil
}

func main() {
	config, err := parseConfig(os.Getenv("HICHAT_BASE"), os.Getenv("BOT_TOKEN"), os.Getenv("WELCOME_SERVER"), os.Getenv("WELCOME_CHANNEL"))
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client := &http.Client{Timeout: 10 * time.Second}
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second
	delay := time.Second
	for ctx.Err() == nil {
		err = runGateway(ctx, config, &dialer, client)
		if ctx.Err() != nil {
			break
		}
		log.Printf("gateway disconnected; retrying after %s: %v", delay, err)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}

func runGateway(ctx context.Context, config botConfig, dialer *websocket.Dialer, client *http.Client) error {
	connection, response, err := dialer.DialContext(ctx, config.gateway, http.Header{"Authorization": {"Bearer " + config.token}})
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return fmt.Errorf("gateway connection failed: %w", err)
	}
	defer connection.Close()
	connection.SetReadLimit(64 * 1024)
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			connection.Close()
		case <-done:
		}
	}()
	for {
		var incoming event
		if err := connection.ReadJSON(&incoming); err != nil {
			return err
		}
		if incoming.Op != "member_join" || (incoming.ServerID != "" && incoming.ServerID != config.server) {
			continue
		}
		var member memberJoin
		if json.Unmarshal(incoming.Data, &member) != nil || member.ID == "" || member.name() == "" {
			continue
		}
		if err := postMessage(ctx, client, config, "Aramiza hos geldin, @"+member.name()+"!"); err != nil {
			log.Printf("welcome could not be posted: %v", err)
		} else {
			log.Print("welcome posted")
		}
	}
}

func postMessage(ctx context.Context, client *http.Client, config botConfig, text string) error {
	destination, err := url.JoinPath(config.base, "api/servers", url.PathEscape(config.server), "channels", url.PathEscape(config.channel), "messages")
	if err != nil {
		return fmt.Errorf("invalid message endpoint")
	}
	body, err := json.Marshal(map[string]string{"content": text})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, destination, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("invalid message request")
	}
	request.Header.Set("Authorization", "Bearer "+config.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("message request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("message endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}
