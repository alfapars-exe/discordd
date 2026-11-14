package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
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

func TestRecoveryEndpointAccountSpecificErrorsKeepSuccessEnvelope(t *testing.T) {
	for _, cause := range []error{errors.New("controlled provider diagnostic"), context.DeadlineExceeded, context.Canceled, pkg.ErrBadRequest, pkg.ErrNotFound, pkg.ErrUnauthorized} {
		t.Run(cause.Error(), func(t *testing.T) {
			service := &recoveryContractService{recover: func(string) (int, error) { return 0, fmt.Errorf("failed to send reset email: %w", cause) }}
			handler := NewAuthHandler(service, nil, nil, nil, nil, nil, nil)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(`{"identifier":"person@example.test"}`))
			handler.ForgotPassword(response, request)
			var body pkg.APIResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusOK || !body.Success || body.Error != "" || body.Code != "" || body.Data == nil {
				t.Fatalf("unexpected public error contract: status=%d envelope=%+v", response.Code, body)
			}
			if response.Body.String() != "{\"success\":true,\"data\":{\"message\":\"if the account exists, a reset link has been sent\"}}\n" {
				t.Fatal("failure envelope differs from accepted recovery")
			}
			if response.Header().Get("Retry-After") != "" || response.Header().Get("Set-Cookie") != "" {
				t.Fatal("provider failure must not issue session or cooldown headers")
			}
		})
	}
}

func TestRecoveryEndpointDisabledConfigurationKeepsBadRequest(t *testing.T) {
	service := &recoveryContractService{recover: func(string) (int, error) { return 0, services.ErrPasswordRecoveryUnavailable }}
	response := httptest.NewRecorder()
	NewAuthHandler(service, nil, nil, nil, nil, nil, nil).ForgotPassword(response, httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(`{"identifier":"any-handle"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("disabled status=%d", response.Code)
	}
}
