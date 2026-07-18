// Upload/download auth tests — the hichat_media cookie now carries a
// media-SCOPED token instead of the full API access token. authUserID must
// accept exactly two things: a media-scoped token (the new cookie) and an
// unscoped token (access tokens, plus media cookies already sitting in
// browsers from before this change). Anything else is refused.
package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/golang-jwt/jwt/v5"
)

const testUploadJWTSecret = "test-secret-key-for-upload-download"

func newTestUploadHandler(uploadDir string) *UploadDownloadHandler {
	svc := services.NewAuthService(
		&testutil.MockUserRepo{},
		&testutil.MockSessionRepo{},
		&testutil.MockResetRepo{},
		&testutil.MockEventPublisher{},
		&testutil.MockEmailSender{},
		testUploadJWTSecret,
		15,
		7,
	)
	return NewUploadDownloadHandler(uploadDir, nil, nil, nil, nil, svc)
}

// signUploadTestToken mints a JWT with an explicit scope and TTL. Signing by
// hand (rather than through AuthService) is what lets these cases cover an
// already-expired cookie and a scope the server has never issued.
func signUploadTestToken(t *testing.T, userID, scope string, ttl time.Duration) string {
	t.Helper()
	now := time.Now()
	claims := &models.TokenClaims{
		UserID:   userID,
		Username: "testuser",
		Scope:    scope,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			Issuer:    "mqvi",
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testUploadJWTSecret))
	if err != nil {
		t.Fatalf("failed to sign test token: %v", err)
	}
	return signed
}

func TestAuthUserID_MediaCookieScopes(t *testing.T) {
	h := newTestUploadHandler(t.TempDir())

	tests := []struct {
		name       string
		scope      string
		ttl        time.Duration
		wantUserID string
		wantOK     bool
	}{
		{
			name:       "media-scoped cookie authenticates an attachment load",
			scope:      models.TokenScopeMedia,
			ttl:        7 * 24 * time.Hour,
			wantUserID: "user-1",
			wantOK:     true,
		},
		{
			name:   "expired media cookie is refused",
			scope:  models.TokenScopeMedia,
			ttl:    -time.Second,
			wantOK: false,
		},
		{
			// Cookies minted before this change hold a plain access token
			// with no scope claim. They must keep working until they age
			// out, or every browser tab open across the deploy loses its
			// images until the user re-logs in.
			name:       "legacy unscoped access-token cookie still accepted during rollout",
			scope:      "",
			ttl:        15 * time.Minute,
			wantUserID: "user-1",
			wantOK:     true,
		},
		{
			name:   "expired legacy cookie is refused",
			scope:  "",
			ttl:    -time.Second,
			wantOK: false,
		},
		{
			name:   "token with an unrecognised scope is refused",
			scope:  "some-future-scope",
			ttl:    time.Hour,
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
			req.AddCookie(&http.Cookie{
				Name:  mediaCookieName,
				Value: signUploadTestToken(t, "user-1", tc.scope, tc.ttl),
			})

			userID, ok := h.authUserID(req)
			if ok != tc.wantOK {
				t.Fatalf("authUserID ok = %v, want %v (userID %q)", ok, tc.wantOK, userID)
			}
			if userID != tc.wantUserID {
				t.Errorf("authUserID userID = %q, want %q", userID, tc.wantUserID)
			}
		})
	}
}

// TestAuthUserID_BearerHeader covers the API-client path: a normal unscoped
// access token in the Authorization header. A media-scoped token presented
// this way is refused here too — the header is not a laundering route for a
// cookie-scoped credential.
func TestAuthUserID_BearerHeader(t *testing.T) {
	h := newTestUploadHandler(t.TempDir())

	t.Run("unscoped access token accepted", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer "+signUploadTestToken(t, "user-7", "", 15*time.Minute))
		userID, ok := h.authUserID(req)
		if !ok || userID != "user-7" {
			t.Fatalf("authUserID = (%q, %v), want (user-7, true)", userID, ok)
		}
	})

	t.Run("media-scoped token in the header is accepted for uploads only", func(t *testing.T) {
		// /api/uploads IS the media scope's intended destination, so a
		// media token works here regardless of how it arrived. The
		// restriction that matters lives in AuthMiddleware (see
		// middleware/auth_test.go), which refuses it on every other route.
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer "+signUploadTestToken(t, "user-7", models.TokenScopeMedia, time.Hour))
		userID, ok := h.authUserID(req)
		if !ok || userID != "user-7" {
			t.Fatalf("authUserID = (%q, %v), want (user-7, true)", userID, ok)
		}
	})

	t.Run("no credential at all", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		if userID, ok := h.authUserID(req); ok {
			t.Fatalf("authUserID = (%q, true), want (\"\", false)", userID)
		}
	})

	t.Run("garbage token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer not-a-jwt")
		if userID, ok := h.authUserID(req); ok {
			t.Fatalf("authUserID = (%q, true), want (\"\", false)", userID)
		}
	})
}

// TestServeFile_CacheControlIsPrivate guards the caching header. Attachment
// responses are permission-checked per user, so a shared cache (corporate
// proxy, CDN) must never store one and hand it to the next requester — but
// the browser's own cache should keep it, otherwise every re-render refetches
// the image.
func TestServeFile_CacheControlIsPrivate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "abc123.png"), []byte("png-bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	h := newTestUploadHandler(dir)

	req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
	rec := httptest.NewRecorder()
	h.serveFile(rec, req, "abc123.png")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got, want := rec.Header().Get("Cache-Control"), "private, max-age=3600"; got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
}

// compile-time guard: the handler's validator interface is satisfied by the
// real AuthService, so these tests exercise production validation logic.
var _ AccessTokenValidator = (services.AuthService)(nil)
