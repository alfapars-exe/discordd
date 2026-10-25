package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/gorilla/websocket"
)

type fakeBotValidatorWS struct{ id string }

func (f fakeBotValidatorWS) ValidateBotToken(context.Context, string) (string, error) {
	return f.id, nil
}

type fakeUserInfo struct{ u *models.User }

func (f fakeUserInfo) GetByID(context.Context, string) (*models.User, error) {
	return f.u, nil
}

// A platform-banned bot, or a token row that resolves to a non-bot user, must
// be rejected before the WS upgrade — matching middleware/auth.go. These paths
// return 401 before any hijack, so httptest's recorder can observe them.
func TestHandleBotConnection_RejectsBannedOrNonBot(t *testing.T) {
	cases := []struct {
		name string
		u    *models.User
	}{
		{"banned", &models.User{ID: "bot_x", IsBot: true, IsPlatformBanned: true}},
		{"not_a_bot", &models.User{ID: "bot_x", IsBot: false}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := &Handler{
				botValidator:     fakeBotValidatorWS{id: "bot_x"},
				userInfoProvider: fakeUserInfo{u: c.u},
			}
			req := httptest.NewRequest("GET", "/api/bot/gateway", nil)
			req.Header.Set("Authorization", "Bearer "+models.BotTokenPrefix+"abc")
			rec := httptest.NewRecorder()
			h.HandleBotConnection(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s: expected 401, got %d", c.name, rec.Code)
			}
		})
	}
}

type sequencedBotValidator struct {
	id            string
	calls         atomic.Int32
	secondStarted chan struct{}
	releaseSecond chan struct{}
	revokeAt      int32
}

func (v *sequencedBotValidator) ValidateBotToken(ctx context.Context, _ string) (string, error) {
	call := v.calls.Add(1)
	if call == 2 && v.secondStarted != nil {
		close(v.secondStarted)
		select {
		case <-v.releaseSecond:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if v.revokeAt > 0 && call >= v.revokeAt {
		return "", pkg.ErrUnauthorized
	}
	return v.id, nil
}

func dialBotGateway(t *testing.T, h *Handler) (*websocket.Conn, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(h.HandleBotConnection))
	header := http.Header{}
	header.Set("Authorization", "Bearer "+models.BotTokenPrefix+"fixture")
	conn, response, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1), header)
	if err != nil {
		server.Close()
		if response != nil {
			t.Fatalf("gateway dial: %v (status %d)", err, response.StatusCode)
		}
		t.Fatalf("gateway dial: %v", err)
	}
	return conn, func() {
		_ = conn.Close()
		server.Close()
	}
}

func waitForBotGatewayClients(t *testing.T, hub *Hub, botID string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hub.mu.RLock()
		got := len(hub.clients[botID])
		hub.mu.RUnlock()
		if got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("bot clients did not become %d", want)
}

func TestBotGatewayRevalidatesAfterHubRegistration(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	validator := &sequencedBotValidator{
		id:            "bot_x",
		secondStarted: make(chan struct{}),
		releaseSecond: make(chan struct{}),
		revokeAt:      2,
	}
	h := &Handler{
		hub:              hub,
		botValidator:     validator,
		userInfoProvider: fakeUserInfo{u: &models.User{ID: "bot_x", IsBot: true}},
	}

	conn, cleanup := dialBotGateway(t, h)
	defer cleanup()
	select {
	case <-validator.secondStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("post-registration validation did not start")
	}
	// The second validation deliberately blocks after the client is visible.
	// A removal committed in this interval must cause that connection to be
	// retired instead of proceeding to its read/write pumps.
	waitForBotGatewayClients(t, hub, "bot_x", 1)
	close(validator.releaseSecond)

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := conn.ReadMessage()
	if err == nil {
		t.Fatal("revoked bot connection stayed open")
	}
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != 4001 {
		t.Fatalf("close error = %v, want websocket 4001", err)
	}
	waitForBotGatewayClients(t, hub, "bot_x", 0)
}

func TestBotGatewayPeriodicallyRevalidatesCredential(t *testing.T) {
	oldPingPeriod := pingPeriod
	pingPeriod = 20 * time.Millisecond
	t.Cleanup(func() { pingPeriod = oldPingPeriod })

	hub := NewHub()
	go hub.Run()
	validator := &sequencedBotValidator{id: "bot_x", revokeAt: 3}
	h := &Handler{
		hub:              hub,
		botValidator:     validator,
		userInfoProvider: fakeUserInfo{u: &models.User{ID: "bot_x", IsBot: true}},
	}
	conn, cleanup := dialBotGateway(t, h)
	defer cleanup()

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := conn.ReadMessage()
	if err == nil {
		t.Fatal("bot connection stayed open after token revalidation failed")
	}
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != 4001 {
		t.Fatalf("close error = %v, want websocket 4001", err)
	}
	if calls := validator.calls.Load(); calls < 3 {
		t.Fatalf("validation calls = %d, want admission, registration, keepalive", calls)
	}
	waitForBotGatewayClients(t, hub, "bot_x", 0)
}
