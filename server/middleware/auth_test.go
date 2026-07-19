package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/golang-jwt/jwt/v5"
)

const testJWTSecret = "test-secret-key-for-auth-middleware"

// newTestAuthMiddleware wires a real AuthService (so token validation is the
// production code path, not a stub) over mock repos.
func newTestAuthMiddleware(userRepo *testutil.MockUserRepo) *AuthMiddleware {
	svc := services.NewAuthService(
		userRepo,
		&testutil.MockSessionRepo{},
		&testutil.MockResetRepo{},
		&testutil.MockEventPublisher{},
		&testutil.MockEmailSender{},
		testJWTSecret,
		15,
		7,
	)
	// nil bot validator: these tests cover the JWT/scope path only.
	// Require checks botValidator != nil before consulting it, so nil is
	// the correct "no bot support in this fixture" value, not a stub.
	return NewAuthMiddleware(svc, userRepo, nil)
}

// signTestToken mints a JWT with the given scope, signed with the same secret
// the test middleware validates against. Crafted by hand rather than via
// AuthService so the test pins the wire format (the "scope" claim) instead of
// whichever generator happens to produce it.
func signTestToken(t *testing.T, userID, scope string, ttl time.Duration) string {
	t.Helper()
	now := time.Now()
	claims := &models.TokenClaims{
		UserID:   userID,
		Username: "testuser",
		Scope:    scope,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("failed to sign test token: %v", err)
	}
	return signed
}

// TestRequire_RejectsScopedTokens is THE security assertion for the scoped
// media-token change.
//
// The hichat_media cookie authenticates browser <img>/<video> loads against
// /api/uploads/*. It used to carry the full API access token, so anyone who
// obtained that cookie (a cross-site leak, a shared machine, a proxy log)
// held a complete API credential: replay it as `Authorization: Bearer` and
// you get every endpoint the user has. The cookie is now a media-scoped
// token, and this test proves the API refuses it.
//
// Under the pre-fix middleware — which validated the JWT and never looked at
// the scope claim — the media-scope case returns 200 and the handler runs.
func TestRequire_RejectsScopedTokens(t *testing.T) {
	tests := []struct {
		name       string
		scope      string
		wantStatus int
		wantCalled bool
	}{
		{
			name:       "media-scoped token must not authenticate an API route",
			scope:      models.TokenScopeMedia,
			wantStatus: http.StatusUnauthorized,
			wantCalled: false,
		},
		{
			name:       "unknown scope is rejected too (deny by default)",
			scope:      "some-future-scope",
			wantStatus: http.StatusUnauthorized,
			wantCalled: false,
		},
		{
			name:       "unscoped access token still works (regression pin)",
			scope:      "",
			wantStatus: http.StatusOK,
			wantCalled: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			userRepo := &testutil.MockUserRepo{
				GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
					return &models.User{ID: id, Username: "testuser"}, nil
				},
			}
			mw := newTestAuthMiddleware(userRepo)

			called := false
			handler := mw.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/users/me", nil)
			req.Header.Set("Authorization", "Bearer "+signTestToken(t, "user-1", tc.scope, 15*time.Minute))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if called != tc.wantCalled {
				t.Errorf("downstream handler called = %v, want %v", called, tc.wantCalled)
			}
		})
	}
}
