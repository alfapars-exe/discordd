package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"golang.org/x/crypto/bcrypt"
)

// Compose the real handler and service; repositories remain explicit fakes.
func TestAuthHTTPNewRegistrationEmailDoesNotBlockLegacyLogin(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("legacy-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	lookups := 0
	users := &testutil.MockUserRepo{GetByUsernameFn: func(_ context.Context, name string) (*models.User, error) {
		lookups++
		if name != "legacy-user" {
			t.Fatal("unexpected username")
		}
		return &models.User{ID: "legacy-id", Username: name, Email: nil, PasswordHash: string(hash)}, nil
	}}
	service := services.NewAuthService(users, &testutil.MockSessionRepo{}, nil, &testutil.MockEventPublisher{}, nil, nil, "legacy-contract-test-key", 15, 7)
	handler := NewAuthHandler(service, nil, nil, nil, nil, nil, nil)
	registration := httptest.NewRecorder()
	handler.Register(registration, httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"username":"new-user","password":"valid-password"}`)))
	if registration.Code != http.StatusBadRequest || lookups != 0 {
		t.Fatalf("email-less new registration status=%d lookups=%d", registration.Code, lookups)
	}
	login := httptest.NewRecorder()
	handler.Login(login, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"legacy-user","password":"legacy-password"}`)))
	var body struct {
		Success bool                `json:"success"`
		Data    services.AuthTokens `json:"data"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if login.Code != http.StatusOK || !body.Success || body.Data.User.ID != "legacy-id" || body.Data.User.Email != nil || body.Data.AccessToken == "" || body.Data.User.PasswordHash != "" {
		t.Fatalf("legacy login contract failed: status=%d success=%t", login.Code, body.Success)
	}
	found := false
	for _, cookie := range login.Result().Cookies() {
		if cookie.Name == "hichat_refresh" && cookie.Value != "" && cookie.HttpOnly {
			found = true
		}
	}
	if !found || lookups != 1 {
		t.Fatal("legacy login must issue refresh cookie after one lookup")
	}
	rejected := httptest.NewRecorder()
	handler.Login(rejected, httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"legacy-user","password":"wrong-password"}`)))
	if rejected.Code != http.StatusUnauthorized || len(rejected.Result().Cookies()) != 0 || lookups != 2 {
		t.Fatal("legacy account must still require the correct password")
	}

}
