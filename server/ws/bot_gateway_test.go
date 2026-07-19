package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
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
