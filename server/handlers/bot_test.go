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

	revokeErr       error
	transferRequest *models.ApplicationTransferRequest
	transferCalls   int
	resolvedToken   string
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

func (f *fakeBotService) RequestOwnershipTransfer(_ context.Context, _, _, _ string) (*models.ApplicationTransferRequest, error) {
	f.transferCalls++
	return f.transferRequest, nil
}

func (f *fakeBotService) ListIncomingOwnershipTransfers(_ context.Context, _ string) ([]models.ApplicationTransferRequest, error) {
	return nil, nil
}

func (f *fakeBotService) ResolveOwnershipTransfer(_ context.Context, _, _ string, _ bool) (string, error) {
	f.transferCalls++
	return f.resolvedToken, nil
}

func (f *fakeBotService) PutApplicationManifest(context.Context, string, string, string, bool, []models.ApplicationAction) (*models.ApplicationManifest, error) {
	return nil, nil
}
func (f *fakeBotService) ListOwnedApplicationManifests(context.Context, string) ([]models.ApplicationManifest, error) {
	return nil, nil
}
func (f *fakeBotService) InstallApplication(context.Context, string, string, string, []string) (*models.ApplicationInstallation, error) {
	return nil, nil
}
func (f *fakeBotService) ListApplicationInstallations(context.Context, string) ([]models.ApplicationInstallation, error) {
	return nil, nil
}
func (f *fakeBotService) ListAvailableApplicationActions(context.Context, string) ([]models.ApplicationAction, error) {
	return nil, nil
}
func (f *fakeBotService) RevokeApplicationInstallation(context.Context, string, string) error {
	return nil
}
func (f *fakeBotService) InvokeApplicationAction(context.Context, string, string, string, string, string) (*models.ApplicationInvocation, error) {
	return nil, nil
}
func (f *fakeBotService) InvokeApplicationTest(context.Context, string, string, string) (*models.ApplicationInvocation, error) {
	return nil, nil
}
func (f *fakeBotService) CompleteApplicationInvocation(context.Context, string, string, string, *string, *string) error {
	return nil
}
func (f *fakeBotService) GetApplicationInvocation(context.Context, string, string) (*models.ApplicationInvocation, error) {
	return nil, nil
}

func TestApplicationTransferHandlersRequireHumanAndReturnRotatedToken(t *testing.T) {
	svc := &fakeBotService{transferRequest: &models.ApplicationTransferRequest{ID: "tr-1", BotUserID: "bot-1"}, resolvedToken: "hb_rotated"}
	h := NewBotHandler(svc)
	botReq := withUser(httptest.NewRequest(http.MethodPost, "/api/bots/bot-1/transfer-requests", strings.NewReader(`{"recipient_username":"next"}`)), &models.User{ID: "bot", IsBot: true})
	botReq.SetPathValue("botID", "bot-1")
	botRec := httptest.NewRecorder()
	h.RequestTransfer(botRec, botReq)
	if botRec.Code != http.StatusForbidden || svc.transferCalls != 0 {
		t.Fatalf("bot status=%d calls=%d", botRec.Code, svc.transferCalls)
	}
	req := withUser(httptest.NewRequest(http.MethodPost, "/api/bots/bot-1/transfer-requests", strings.NewReader(`{"recipient_username":"next"}`)), &models.User{ID: "owner"})
	req.SetPathValue("botID", "bot-1")
	rec := httptest.NewRecorder()
	h.RequestTransfer(rec, req)
	if rec.Code != http.StatusCreated || svc.transferCalls != 1 {
		t.Fatalf("request status=%d calls=%d body=%s", rec.Code, svc.transferCalls, rec.Body.String())
	}
	accept := withUser(httptest.NewRequest(http.MethodPost, "/api/application-transfer-requests/tr-1/resolve", strings.NewReader(`{"accept":true}`)), &models.User{ID: "recipient"})
	accept.SetPathValue("requestID", "tr-1")
	acceptRec := httptest.NewRecorder()
	h.ResolveTransfer(acceptRec, accept)
	if acceptRec.Code != http.StatusOK || !strings.Contains(acceptRec.Body.String(), "hb_rotated") {
		t.Fatalf("accept status=%d body=%s", acceptRec.Code, acceptRec.Body.String())
	}
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

func TestBotCreate_StrictBoundedJSON(t *testing.T) {
	for _, body := range []string{
		`{"username":"weatherbot","display_name":"W","unexpected":true}`,
		`{"username":"weatherbot","display_name":"W"} {}`,
		`{"username":"` + strings.Repeat("x", 9000) + `","display_name":"W"}`,
	} {
		svc := &fakeBotService{}
		h := NewBotHandler(svc)
		req := withUser(httptest.NewRequest(http.MethodPost, "/api/bots", strings.NewReader(body)), &models.User{ID: "owner-1"})
		rec := httptest.NewRecorder()
		h.Create(rec, req)
		if rec.Code != http.StatusBadRequest || svc.createCalls != 0 {
			t.Fatalf("status=%d calls=%d body=%s", rec.Code, svc.createCalls, rec.Body.String())
		}
	}
}
