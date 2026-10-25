package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type recoveryContractService struct {
	stubAuthService
	recover func(string) (int, error)
}

func (s *recoveryContractService) ForgotPassword(_ context.Context, identifier string) (int, error) {
	return s.recover(identifier)
}

func TestRecoveryEndpointKeepsKnownUnknownAndCooldownResponsesEquivalent(t *testing.T) {
	var expected string
	for _, tc := range []struct {
		name, identifier string
		cooldown         int
	}{
		{"email", "person@example.test", 0},
		{"username", "legacy-handle", 0},
		{"unknown", "unknown-handle", 0},
		{"cooldown", "person@example.test", 89},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			service := &recoveryContractService{recover: func(identifier string) (int, error) {
				called = true
				if identifier != tc.identifier {
					t.Errorf("identifier changed: %q", identifier)
				}
				return tc.cooldown, nil
			}}
			handler := NewAuthHandler(service, nil, nil, nil, nil, nil, nil)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(`{"identifier":"`+tc.identifier+`"}`))
			handler.ForgotPassword(response, request)
			if !called || response.Code != http.StatusOK || response.Header().Get("Retry-After") != "" {
				t.Fatalf("unexpected endpoint outcome: %d", response.Code)
			}
			if expected == "" {
				expected = response.Body.String()
			}
			if response.Body.String() != expected {
				t.Fatal("public response disclosed identifier existence/cooldown")
			}
		})
	}
}
