// Refresh-cookie attribute tests.
//
// Background (the ".exe session doesn't persist" bug): the packaged Electron
// renderer runs at origin app://hichat while the API lives on a different
// host, so EVERY API call from the desktop app is cross-site. Chromium
// rejects a SameSite=Strict cookie at SET time on a cross-site response —
// the desktop app therefore never stored hichat_refresh at all. Login looked
// like it worked (the access token comes back in the JSON body) but on
// relaunch the in-memory access token was gone, /api/users/me 401'd, and
// /api/auth/refresh had no cookie to send. Users read the resulting bounce
// to /login as "my registration didn't work".
//
// These tests pin the fix: native clients (identified by the X-HiChat-Client
// header) get SameSite=None, web keeps SameSite=Strict, and the cookie is
// only honoured on requests that carry the header (the CSRF gate that makes
// SameSite=None safe here).
package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

// ─── Stub AuthService ───
//
// Deliberately local to this file rather than in testutil: these tests care
// only about the HTTP cookie surface, so the stub returns fixed tokens and
// records nothing else. Following the testutil idiom of optional *Fn hooks
// with inert defaults.
type stubAuthService struct {
	refreshTokenFn func(ctx context.Context, refreshToken string) (*services.AuthTokens, error)
	logoutFn       func(ctx context.Context, refreshToken string) error
}

const (
	stubAccessToken  = "stub-access-token"
	stubRefreshToken = "stub-refresh-token"
	stubUserID       = "user-123"
)

func stubTokens() *services.AuthTokens {
	return &services.AuthTokens{
		AccessToken:  stubAccessToken,
		RefreshToken: stubRefreshToken,
		User:         models.User{ID: stubUserID, Username: "stubuser"},
	}
}

func (s *stubAuthService) Register(_ context.Context, _ *models.CreateUserRequest) (*services.AuthTokens, error) {
	return stubTokens(), nil
}

func (s *stubAuthService) Login(_ context.Context, _ *models.LoginRequest) (*services.AuthTokens, error) {
	return stubTokens(), nil
}

func (s *stubAuthService) RefreshToken(ctx context.Context, refreshToken string) (*services.AuthTokens, error) {
	if s.refreshTokenFn != nil {
		return s.refreshTokenFn(ctx, refreshToken)
	}
	return stubTokens(), nil
}

func (s *stubAuthService) Logout(ctx context.Context, refreshToken string) error {
	if s.logoutFn != nil {
		return s.logoutFn(ctx, refreshToken)
	}
	return nil
}

func (s *stubAuthService) ValidateAccessToken(_ string) (*models.TokenClaims, error) {
	return nil, errors.New("not implemented in stub")
}

func (s *stubAuthService) GenerateMediaToken(_ string) (string, error) {
	return "stub-media-token", nil
}

func (s *stubAuthService) ChangePassword(_ context.Context, _, _, _ string) error { return nil }
func (s *stubAuthService) ChangeEmail(_ context.Context, _, _, _ string) error    { return nil }
func (s *stubAuthService) ForgotPassword(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (s *stubAuthService) ResetPassword(_ context.Context, _, _ string) error { return nil }
func (s *stubAuthService) SetAppLogger(_ services.AuthAppLogger)              {}

func newCookieTestHandler(svc services.AuthService) *AuthHandler {
	// All limiters nil — rate limiting is orthogonal to cookie attributes.
	return NewAuthHandler(svc, nil, nil, nil, nil, nil, nil)
}

// ─── Helpers ───

// findSetCookie returns the parsed Set-Cookie entries for the given name.
// Returns every match because clearRefreshCookie deliberately emits more
// than one variant.
func findSetCookies(t *testing.T, rec *httptest.ResponseRecorder, name string) []*http.Cookie {
	t.Helper()
	var out []*http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			out = append(out, c)
		}
	}
	return out
}

// requireOneSetCookie asserts exactly one Set-Cookie for name and returns it.
func requireOneSetCookie(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	got := findSetCookies(t, rec, name)
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 %q Set-Cookie, got %d (raw: %v)",
			name, len(got), rec.Result().Header["Set-Cookie"])
	}
	return got[0]
}

// assertRefreshCookieShape checks the invariants that hold for EVERY
// refresh cookie regardless of client: HttpOnly (out of reach of XSS),
// Secure, and scoped to /api/auth so it never rides along on unrelated
// endpoints.
func assertRefreshCookieShape(t *testing.T, c *http.Cookie) {
	t.Helper()
	if !c.HttpOnly {
		t.Error("refresh cookie must be HttpOnly")
	}
	if !c.Secure {
		t.Error("refresh cookie must be Secure")
	}
	if c.Path != "/api/auth" {
		t.Errorf("refresh cookie Path = %q, want %q", c.Path, "/api/auth")
	}
}

func sameSiteName(s http.SameSite) string {
	switch s {
	case http.SameSiteDefaultMode:
		return "Default(unset)"
	case http.SameSiteLaxMode:
		return "Lax"
	case http.SameSiteStrictMode:
		return "Strict"
	case http.SameSiteNoneMode:
		return "None"
	}
	return "unknown"
}

func assertSameSite(t *testing.T, c *http.Cookie, want http.SameSite) {
	t.Helper()
	if c.SameSite != want {
		t.Errorf("SameSite = %s, want %s", sameSiteName(c.SameSite), sameSiteName(want))
	}
}

// ─── Login / Register / Refresh: SameSite depends on the client ───

func TestRefreshCookie_SameSitePerClient(t *testing.T) {
	// Each entry runs against all three token-issuing endpoints.
	clients := []struct {
		name         string
		headerValue  string // "" = header absent (a browser)
		wantSameSite http.SameSite
	}{
		{
			name:         "electron desktop shell",
			headerValue:  "electron",
			wantSameSite: http.SameSiteNoneMode,
		},
		{
			name:         "capacitor mobile shell",
			headerValue:  "capacitor",
			wantSameSite: http.SameSiteNoneMode,
		},
		{
			// Web regression pin. The browser client is same-site with the
			// API, so it keeps the strongest possible CSRF posture.
			name:         "web browser (no header)",
			headerValue:  "",
			wantSameSite: http.SameSiteStrictMode,
		},
		{
			// The header exists to identify OUR native shells. An unknown
			// value must not be able to downgrade a web session's cookie.
			name:         "unrecognised client value",
			headerValue:  "totally-made-up",
			wantSameSite: http.SameSiteStrictMode,
		},
	}

	endpoints := []struct {
		name     string
		body     string
		invoke   func(h *AuthHandler) http.HandlerFunc
		wantHTTP int
	}{
		{
			name:     "Register",
			body:     `{"username":"stubuser","password":"hunter2hunter2"}`,
			invoke:   func(h *AuthHandler) http.HandlerFunc { return h.Register },
			wantHTTP: http.StatusCreated,
		},
		{
			name:     "Login",
			body:     `{"username":"stubuser","password":"hunter2hunter2"}`,
			invoke:   func(h *AuthHandler) http.HandlerFunc { return h.Login },
			wantHTTP: http.StatusOK,
		},
		{
			name:     "Refresh",
			body:     `{"refresh_token":"some-old-token"}`,
			invoke:   func(h *AuthHandler) http.HandlerFunc { return h.Refresh },
			wantHTTP: http.StatusOK,
		},
	}

	for _, ep := range endpoints {
		for _, cl := range clients {
			t.Run(ep.name+"/"+cl.name, func(t *testing.T) {
				h := newCookieTestHandler(&stubAuthService{})

				req := httptest.NewRequest(http.MethodPost, "/api/auth/x", strings.NewReader(ep.body))
				req.Header.Set("Content-Type", "application/json")
				if cl.headerValue != "" {
					req.Header.Set(clientHintHeader, cl.headerValue)
				}

				rec := httptest.NewRecorder()
				ep.invoke(h)(rec, req)

				if rec.Code != ep.wantHTTP {
					t.Fatalf("status = %d, want %d (body: %s)", rec.Code, ep.wantHTTP, rec.Body.String())
				}

				c := requireOneSetCookie(t, rec, refreshCookieName)
				if c.Value != stubRefreshToken {
					t.Errorf("cookie value = %q, want %q", c.Value, stubRefreshToken)
				}
				assertRefreshCookieShape(t, c)
				assertSameSite(t, c, cl.wantSameSite)
			})
		}
	}
}

// ─── The exact desktop scenario that was never covered ───

// TestRefresh_ElectronCrossSite is the regression test for the reported bug.
// It reproduces a relaunched desktop app: a cross-site POST from the
// app://hichat origin carrying the refresh cookie plus the client header.
// The session must be renewed AND the rotated cookie must again be
// SameSite=None, otherwise the very next relaunch is logged out again.
func TestRefresh_ElectronCrossSite(t *testing.T) {
	var seenToken string
	svc := &stubAuthService{
		refreshTokenFn: func(_ context.Context, refreshToken string) (*services.AuthTokens, error) {
			seenToken = refreshToken
			return stubTokens(), nil
		},
	}
	h := newCookieTestHandler(svc)

	// Empty body: the desktop client sends "{}" and relies purely on the cookie.
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "app://hichat")
	req.Header.Set(clientHintHeader, "electron")
	req.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "cookie-carried-token"})

	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if seenToken != "cookie-carried-token" {
		t.Errorf("service received refresh token %q, want the cookie value", seenToken)
	}

	c := requireOneSetCookie(t, rec, refreshCookieName)
	assertRefreshCookieShape(t, c)
	assertSameSite(t, c, http.SameSiteNoneMode)
	if c.Value != stubRefreshToken {
		t.Errorf("rotated cookie value = %q, want the new token %q", c.Value, stubRefreshToken)
	}
}

// ─── CSRF gate ───

// TestRefresh_CookieIgnoredWithoutClientHeader pins the property that makes
// SameSite=None acceptable for this cookie.
//
// A cross-site attacker page can issue a "simple" request (form POST, img,
// etc.) that carries the victim's SameSite=None cookie, but it CANNOT attach
// a custom header without triggering a CORS preflight — which our origin
// allowlist rejects for any third-party site. Requiring X-HiChat-Client
// before honouring the cookie therefore neutralises the two classic
// SameSite=None risks: forced token rotation (logging the victim out by
// burning their refresh token) and logout-CSRF.
func TestRefresh_CookieIgnoredWithoutClientHeader(t *testing.T) {
	called := false
	svc := &stubAuthService{
		refreshTokenFn: func(_ context.Context, _ string) (*services.AuthTokens, error) {
			called = true
			return stubTokens(), nil
		},
	}
	h := newCookieTestHandler(svc)

	// Attacker-shaped request: victim's cookie rides along, no custom header,
	// and an empty JSON body (the attacker cannot read the token to forge one).
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "victim-refresh-token"})

	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if called {
		t.Error("cookie was honoured without the client header — CSRF gate is open")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (cookie ignored, empty body falls through)", rec.Code)
	}
}

// TestRefresh_BodyFallbackStaysUngated documents the deliberate asymmetry:
// the body path needs no header. An attacker cannot read the victim's
// refresh token, so they cannot put one in a body — the body path carries
// its own proof of possession. Native clients predating the cookie
// migration keep working through it.
func TestRefresh_BodyFallbackStaysUngated(t *testing.T) {
	var seenToken string
	svc := &stubAuthService{
		refreshTokenFn: func(_ context.Context, refreshToken string) (*services.AuthTokens, error) {
			seenToken = refreshToken
			return stubTokens(), nil
		},
	}
	h := newCookieTestHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh",
		strings.NewReader(`{"refresh_token":"legacy-body-token"}`))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.Refresh(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if seenToken != "legacy-body-token" {
		t.Errorf("service received %q, want the body token", seenToken)
	}
}

// ─── Logout ───

// TestLogout_ClearsBothCookieVariants: the clearing Set-Cookie must be
// acceptable to the jar that stored the original. A Strict-only clear is
// REJECTED by Chromium on a cross-site logout response, which would leave a
// live refresh cookie behind after the user pressed "log out". Emitting both
// variants means whichever one the browser accepts performs the deletion —
// they are both deletions (empty value, negative Max-Age), so ordering is
// irrelevant.
func TestLogout_ClearsBothCookieVariants(t *testing.T) {
	var loggedOut string
	svc := &stubAuthService{
		logoutFn: func(_ context.Context, refreshToken string) error {
			loggedOut = refreshToken
			return nil
		},
	}
	h := newCookieTestHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "app://hichat")
	req.Header.Set(clientHintHeader, "electron")
	req.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "session-to-kill"})

	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if loggedOut != "session-to-kill" {
		t.Errorf("service invalidated %q, want the cookie token", loggedOut)
	}

	got := findSetCookies(t, rec, refreshCookieName)
	if len(got) != 2 {
		t.Fatalf("expected 2 clearing Set-Cookie headers (None + Strict), got %d (raw: %v)",
			len(got), rec.Result().Header["Set-Cookie"])
	}

	seen := map[http.SameSite]bool{}
	for _, c := range got {
		if c.Value != "" {
			t.Errorf("clearing cookie has non-empty value %q", c.Value)
		}
		if c.MaxAge >= 0 {
			t.Errorf("clearing cookie MaxAge = %d, want negative", c.MaxAge)
		}
		assertRefreshCookieShape(t, c)
		seen[c.SameSite] = true
	}
	if !seen[http.SameSiteNoneMode] || !seen[http.SameSiteStrictMode] {
		t.Errorf("want both SameSite=None and SameSite=Strict clears, got %v", got)
	}
}

// TestLogout_WebClearsBothVariants: a web logout emits the same pair. The
// Strict clear is the one its jar accepts; the None clear is inert for it.
// Keeping the behaviour identical avoids a second code path to reason about.
func TestLogout_WebClearsBothVariants(t *testing.T) {
	h := newCookieTestHandler(&stubAuthService{})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := findSetCookies(t, rec, refreshCookieName); len(got) != 2 {
		t.Fatalf("expected 2 clearing Set-Cookie headers, got %d", len(got))
	}
}

// TestLogout_CookieIgnoredWithoutClientHeader — the logout-CSRF half of the
// gate. A cross-site page must not be able to burn the victim's session by
// pointing a form at /api/auth/logout.
func TestLogout_CookieIgnoredWithoutClientHeader(t *testing.T) {
	called := false
	svc := &stubAuthService{
		logoutFn: func(_ context.Context, _ string) error {
			called = true
			return nil
		},
	}
	h := newCookieTestHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: refreshCookieName, Value: "victim-refresh-token"})

	rec := httptest.NewRecorder()
	h.Logout(rec, req)

	if called {
		t.Error("logout consumed the cookie without the client header — CSRF gate is open")
	}
	// Logout stays idempotent: still 200, still clears cookies.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (logout is idempotent)", rec.Code)
	}
}
