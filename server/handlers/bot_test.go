package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// fakeBotService is a hand-rolled BotService double. Each field records the last
// call and lets a test stub the return value; createCalls counts invocations so
// the guard tests can assert the service was never reached.
type fakeBotService struct {
	createCalls int
	createBot   *models.User
	createToken string
	createErr   error

	listBots []models.User
	listErr  error

	revokeErr error
}

func (f *fakeBotService) CreateBot(_ context.Context, _ string, _ models.CreateBotRequest) (*models.User, string, error) {
	f.createCalls++
	return f.createBot, f.createToken, f.createErr
}

func (f *fakeBotService) ListBots(_ context.Context, _ string) ([]models.User, error) {
	return f.listBots, f.listErr
}

func (f *fakeBotService) RevokeAllTokens(_ context.Context, _, _ string) error {
	return f.revokeErr
}

var _ BotService = (*fakeBotService)(nil)

// withUser attaches an authenticated caller to the request the same way the
// auth middleware does in production (UserContextKey).
func withUser(r *http.Request, u *models.User) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), UserContextKey, u))
}

// TestBotCreate_HappyPath: a non-bot caller posting a valid body gets 201 and
// the response envelope carries the one-time token.
func TestBotCreate_HappyPath(t *testing.T) {
	dn := "W"
	svc := &fakeBotService{
		createBot:   &models.User{ID: "bot-1", Username: "weatherbot", DisplayName: &dn, IsBot: true},
		createToken: "hb_secret-token",
	}
	h := NewBotHandler(svc)

	body := strings.NewReader(`{"username":"weatherbot","display_name":"W"}`)
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/bots", body), &models.User{ID: "owner-1"})
	rec := httptest.NewRecorder()

	h.Create(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	if svc.createCalls != 1 {
		t.Fatalf("CreateBot called %d times, want 1", svc.createCalls)
	}

	// Response is wrapped in pkg.APIResponse{success,data}. Reach into
	// data.token and confirm the plaintext token is surfaced exactly once.
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Success {
		t.Errorf("success = false, want true")
	}
	if resp.Data.Token != "hb_secret-token" {
		t.Errorf("token = %q, want hb_secret-token", resp.Data.Token)
	}
}

// TestBotCreate_BotCallerForbidden: when the caller is itself a bot, the guard
// returns 403 and the service is never invoked (a bot can't mint bots).
func TestBotCreate_BotCallerForbidden(t *testing.T) {
	svc := &fakeBotService{}
	h := NewBotHandler(svc)

	body := strings.NewReader(`{"username":"weatherbot","display_name":"W"}`)
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/bots", body), &models.User{ID: "bot-caller", IsBot: true})
	rec := httptest.NewRecorder()

	h.Create(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if svc.createCalls != 0 {
		t.Errorf("CreateBot called %d times, want 0 (guard must short-circuit)", svc.createCalls)
	}
}
