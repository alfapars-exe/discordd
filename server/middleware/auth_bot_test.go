package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// fakeBotValidator stands in for services.BotService: it resolves any bot
// token to a fixed bot user id (or a fixed error).
type fakeBotValidator struct {
	id  string
	err error
}

func (f fakeBotValidator) ValidateBotToken(_ context.Context, _ string) (string, error) {
	return f.id, f.err
}

// TestRequire_BotTokenSetsBotUser verifies the hb_-prefixed bot path:
// ValidateBotToken resolves the token, GetByID loads the bot users row, and
// the handler downstream sees that *models.User in handlers.UserContextKey —
// so every existing REST handler works for bots unchanged.
func TestRequire_BotTokenSetsBotUser(t *testing.T) {
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			return &models.User{ID: id, Username: "weatherbot", IsBot: true}, nil
		},
	}
	// authService is nil: the bot branch returns before any JWT validation,
	// so the human path's authService is never touched on this request.
	m := NewAuthMiddleware(nil, userRepo, fakeBotValidator{id: "bot_x"})

	var gotUser *models.User
	handler := m.Require(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if u, ok := r.Context().Value(handlers.UserContextKey).(*models.User); ok {
			gotUser = u
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/users/me", nil)
	req.Header.Set("Authorization", "Bearer hb_abc")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("bot request should pass auth, got status %d", rec.Code)
	}
	if gotUser == nil {
		t.Fatal("handler saw no user in context")
	}
	if gotUser.ID != "bot_x" {
		t.Fatalf("context user id: want %q, got %q", "bot_x", gotUser.ID)
	}
	if !gotUser.IsBot {
		t.Fatal("context user should be a bot (IsBot=true)")
	}
}
