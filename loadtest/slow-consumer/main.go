// Command slow-consumer observes a non-reading, authenticated loopback WebSocket.
// It never grades a workload: the surrounding fixture must prove isolation.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const receiveBufferBytes = 1024

type probeConfig struct {
	BaseURL     string `json:"base_url"`
	AccessToken string `json:"access_token"`
	HoldSeconds int    `json:"hold_seconds"`
}

type probeEvent struct {
	Event                  string    `json:"event"`
	At                     time.Time `json:"at"`
	Reason                 string    `json:"reason,omitempty"`
	KeepalivePairs         int       `json:"keepalive_pairs"`
	ElapsedMS              int64     `json:"elapsed_ms"`
	ReceiveBufferRequested int       `json:"receive_buffer_requested_bytes"`
	PostUpgradeReader      bool      `json:"post_upgrade_reader"`
}

func readConfig(input io.Reader) (probeConfig, error) {
	var config probeConfig
	data, err := io.ReadAll(io.LimitReader(input, 16*1024+1))
	if err != nil || len(data) > 16*1024 {
		return config, errors.New("invalid_config")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, errors.New("invalid_config")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return config, errors.New("invalid_config")
	}
	return config, validateConfig(config)
}

func validateConfig(config probeConfig) error {
	u, err := url.Parse(config.BaseURL)
	if err != nil || u == nil {
		return errors.New("invalid_loopback_url")
	}
	ip, err := netip.ParseAddr(u.Hostname())
	if err != nil || !ip.IsLoopback() || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || strings.ContainsAny(config.BaseURL, "?#") || (u.Path != "" && u.Path != "/") {
		return errors.New("invalid_loopback_url")
	}
	if config.AccessToken == "" || len(config.AccessToken) > 8192 || strings.ContainsAny(config.AccessToken, "\r\n") ||
		config.HoldSeconds < 1 || config.HoldSeconds > 900 {
		return errors.New("invalid_config")
	}
	return nil
}

func issueTicket(ctx context.Context, config probeConfig) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.BaseURL, "/")+"/api/auth/ws-ticket", nil)
	if err != nil {
		return "", errors.New("ticket_request_failed")
	}
	request.Header.Set("Authorization", "Bearer "+config.AccessToken)
	client := &http.Client{
		Timeout:       5 * time.Second,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("ticket_request_failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	var body struct {
		Success bool `json:"success"`
		Data    struct {
			Ticket string `json:"ticket"`
		} `json:"data"`
	}
	if err != nil || len(data) > 8192 || response.StatusCode != http.StatusOK || json.Unmarshal(data, &body) != nil ||
		!body.Success || body.Data.Ticket == "" || len(body.Data.Ticket) > 4096 {
		return "", errors.New("ticket_rejected")
	}
	return body.Data.Ticket, nil
}

func dialProbe(ctx context.Context, base, ticket string) (*websocket.Conn, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, Proxy: nil}
	dialer.NetDialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		tcp, ok := conn.(*net.TCPConn)
		if !ok {
			_ = conn.Close()
			return nil, errors.New("tcp_required")
		}
		if err := tcp.SetReadBuffer(receiveBufferBytes); err != nil {
			_ = conn.Close()
			return nil, err
		}
		return conn, nil
	}
	u, _ := url.Parse(strings.TrimRight(base, "/"))
	u.Scheme = strings.Replace(u.Scheme, "http", "ws", 1)
	u.Path = "/ws"
	u.RawQuery = url.Values{"ticket": []string{ticket}}.Encode()
	conn, response, err := dialer.DialContext(ctx, u.String(), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, errors.New("socket_connect_failed")
	}
	return conn, nil
}

func writeKeepalive(conn *websocket.Conn) error {
	deadline := time.Now().Add(3 * time.Second)
	// Unsolicited protocol pongs keep the server read deadline live without
	// draining its output. Heartbeats separately exercise the application path.
	if err := conn.WriteControl(websocket.PongMessage, nil, deadline); err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return conn.WriteJSON(map[string]string{"op": "heartbeat"})
}

func runProbe(parent context.Context, config probeConfig, output io.Writer) error {
	if err := validateConfig(config); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(config.HoldSeconds)*time.Second)
	defer cancel()
	ticket, err := issueTicket(ctx, config)
	if err != nil {
		return err
	}
	conn, err := dialProbe(ctx, config.BaseURL, ticket)
	if err != nil {
		return err
	}
	defer conn.Close()
	session := probeSession{conn: conn, encoder: json.NewEncoder(output), started: time.Now()}
	if err := session.emit("connected", ""); err != nil {
		return err
	}
	return session.hold(ctx, parent)
}

type probeSession struct {
	conn    *websocket.Conn
	encoder *json.Encoder
	started time.Time
	pairs   int
}

func (s *probeSession) emit(event, reason string) error {
	err := s.encoder.Encode(probeEvent{Event: event, At: time.Now().UTC(), Reason: reason,
		KeepalivePairs: s.pairs, ElapsedMS: time.Since(s.started).Milliseconds(), ReceiveBufferRequested: receiveBufferBytes})
	if err != nil {
		return errors.New("output_failed")
	}
	return nil
}

func (s *probeSession) hold(ctx, parent context.Context) error {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if err := writeKeepalive(s.conn); err != nil {
			return s.emit("finished", "write_failed")
		}
		s.pairs++
		select {
		case <-ctx.Done():
			return s.finish(parent)
		case <-ticker.C:
		}
	}
}

func (s *probeSession) finish(parent context.Context) error {
	reason := "hold_completed"
	if parent.Err() != nil {
		reason = "cancelled"
	}
	return s.emit("finished", reason)
}

func main() {
	config, err := readConfig(os.Stdin)
	if err == nil {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		err = runProbe(ctx, config, os.Stdout)
	}
	if err != nil {
		// Errors are fixed codes; neither tokens, ticket URLs nor response bodies
		// are printed. The fixture owns diagnostic server logs.
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"event": "error", "code": err.Error()})
		os.Exit(1)
	}
}
