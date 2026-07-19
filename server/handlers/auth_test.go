// AuthHandler request/response contract tests.
//
// auth_cookie_test.go covers the Set-Cookie surface (SameSite per client, the
// CSRF header gate, logout clearing both variants). This file covers what the
// CLIENT parses: the JSON envelope on success, the status/message on failure,
// and one security property that is easy to regress and expensive to notice —
//
//	an error response must never echo an internal error string.
//
// pkg.Error is the chokepoint: domain (4xx) errors carry client-safe text and
// are returned verbatim, everything else is logged server-side and replaced
// with a flat "internal server error". A service that starts returning a bare
// fmt.Errorf wrapping a driver message would otherwise quietly begin shipping
// table names, file paths and query fragments to anyone who can hit /login
// (CWE-209).
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// leakyInternalError is what a repository failure realistically looks like by
// the time it reaches the handler: a wrapped chain carrying the driver's
// message, the table name and an on-disk path. None of it may reach the wire.
// The fragments are asserted individually so a partial leak still fails.
var leakyInternalErrorFragments = []string{
	"sqlite",
	"no such table",
	"password_hash",
	"/var/lib/hichat/data.db",
}

func leakyInternalError() error {
	return fmt.Errorf("failed to load user: %w",
		fmt.Errorf("sqlite: no such table: password_hash in /var/lib/hichat/data.db"))
}

// authCase is one request against one endpoint.
type authCase struct {
	name string
	// endpoint selects the handler method under test.
	endpoint func(h *AuthHandler) http.HandlerFunc
	// svc is the AuthService the handler is built over.
	svc *stubAuthService
	// body is the raw request body (kept as a string so malformed JSON is
	// expressible).
	body string
	// clientHint, when set, is sent as X-HiChat-Client.
	clientHint string
	// cookie, when set, is attached as the refresh cookie.
	cookie string

	wantStatus int
	// wantSuccess is the envelope's `success` field.
	wantSuccess bool
	// wantError, when set, must equal the envelope's `error` field exactly.
	wantError string
	// wantAccessToken asserts data.access_token on a success response.
	wantAccessToken string
	// wantNoInternalLeak runs the fragment scan over the whole raw body.
	wantNoInternalLeak bool
}

func register(h *AuthHandler) http.HandlerFunc { return h.Register }
func login(h *AuthHandler) http.HandlerFunc    { return h.Login }
func refresh(h *AuthHandler) http.HandlerFunc  { return h.Refresh }
func logout(h *AuthHandler) http.HandlerFunc   { return h.Logout }

func TestAuthHandler_RequestResponseContract(t *testing.T) {
	// invalidCreds is the shape a service returns for a bad username or
	// password: a domain sentinel wrapping a message that IS safe to show.
	invalidCreds := func(_ context.Context, _ *models.LoginRequest) (*services.AuthTokens, error) {
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	cases := []authCase{
		// ─── success shapes ───
		{
			name:            "register returns 201 with the access token in the envelope",
			endpoint:        register,
			svc:             &stubAuthService{},
			body:            `{"username":"stubuser","password":"hunter2hunter2"}`,
			wantStatus:      http.StatusCreated,
			wantSuccess:     true,
			wantAccessToken: stubAccessToken,
		},
		{
			name:            "login returns 200 with the access token in the envelope",
			endpoint:        login,
			svc:             &stubAuthService{},
			body:            `{"username":"stubuser","password":"hunter2hunter2"}`,
			wantStatus:      http.StatusOK,
			wantSuccess:     true,
			wantAccessToken: stubAccessToken,
		},
		{
			name:            "refresh via body token returns 200 with a rotated access token",
			endpoint:        refresh,
			svc:             &stubAuthService{},
			body:            `{"refresh_token":"old-token"}`,
			wantStatus:      http.StatusOK,
			wantSuccess:     true,
			wantAccessToken: stubAccessToken,
		},
		{
			name:        "logout returns 200",
			endpoint:    logout,
			svc:         &stubAuthService{},
			body:        `{"refresh_token":"old-token"}`,
			wantStatus:  http.StatusOK,
			wantSuccess: true,
		},
		{
			// Logout is idempotent by design: no token to invalidate is not
			// an error, the client still wants its cookies cleared.
			name:        "logout with no token at all still returns 200",
			endpoint:    logout,
			svc:         &stubAuthService{},
			body:        `{}`,
			wantStatus:  http.StatusOK,
			wantSuccess: true,
		},

		// ─── invalid credentials ───
		{
			name:        "login with wrong credentials returns 401 with the safe domain message",
			endpoint:    login,
			svc:         &stubAuthService{loginFn: invalidCreds},
			body:        `{"username":"stubuser","password":"wrong"}`,
			wantStatus:  http.StatusUnauthorized,
			wantSuccess: false,
			wantError:   "unauthorized: invalid username or password",
		},
		{
			name:     "register with a taken username returns 409",
			endpoint: register,
			svc: &stubAuthService{
				registerFn: func(_ context.Context, _ *models.CreateUserRequest) (*services.AuthTokens, error) {
					return nil, fmt.Errorf("%w: username is taken", pkg.ErrAlreadyExists)
				},
			},
			body:        `{"username":"stubuser","password":"hunter2hunter2"}`,
			wantStatus:  http.StatusConflict,
			wantSuccess: false,
			wantError:   "already exists: username is taken",
		},
		{
			name:     "refresh with a revoked token returns 401",
			endpoint: refresh,
			svc: &stubAuthService{
				refreshTokenFn: func(_ context.Context, _ string) (*services.AuthTokens, error) {
					return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
				},
			},
			body:        `{"refresh_token":"revoked"}`,
			wantStatus:  http.StatusUnauthorized,
			wantSuccess: false,
			wantError:   "unauthorized: invalid refresh token",
		},
		{
			name:        "refresh with no token anywhere returns 400",
			endpoint:    refresh,
			svc:         &stubAuthService{},
			body:        `{}`,
			wantStatus:  http.StatusBadRequest,
			wantSuccess: false,
			wantError:   "refresh_token is required",
		},

		// ─── malformed body ───
		{
			name:        "register with unparseable JSON returns 400",
			endpoint:    register,
			svc:         &stubAuthService{},
			body:        `{"username":`,
			wantStatus:  http.StatusBadRequest,
			wantSuccess: false,
			wantError:   "invalid request body",
		},
		{
			name:        "login with unparseable JSON returns 400",
			endpoint:    login,
			svc:         &stubAuthService{},
			body:        `not json at all`,
			wantStatus:  http.StatusBadRequest,
			wantSuccess: false,
			wantError:   "invalid request body",
		},
		{
			name:        "login with an empty body returns 400",
			endpoint:    login,
			svc:         &stubAuthService{},
			body:        ``,
			wantStatus:  http.StatusBadRequest,
			wantSuccess: false,
			wantError:   "invalid request body",
		},
		{
			// Refresh and Logout deliberately tolerate a broken body: the
			// cookie is the primary source and a native client may send
			// nothing at all. A malformed body degrades to "no body token",
			// not to a parse error.
			name:        "refresh tolerates a malformed body and falls through to the missing-token error",
			endpoint:    refresh,
			svc:         &stubAuthService{},
			body:        `{{{`,
			wantStatus:  http.StatusBadRequest,
			wantSuccess: false,
			wantError:   "refresh_token is required",
		},
		{
			name:        "logout tolerates a malformed body and stays idempotent",
			endpoint:    logout,
			svc:         &stubAuthService{},
			body:        `{{{`,
			wantStatus:  http.StatusOK,
			wantSuccess: true,
		},
		{
			name:        "refresh honours the cookie even when the body is malformed",
			endpoint:    refresh,
			svc:         &stubAuthService{},
			body:        `<html>`,
			clientHint:  "electron",
			cookie:      "cookie-token",
			wantStatus:  http.StatusOK,
			wantSuccess: true,
		},

		// ─── internal errors must not leak ───
		{
			name:     "register internal failure returns a generic 500",
			endpoint: register,
			svc: &stubAuthService{registerFn: func(_ context.Context, _ *models.CreateUserRequest) (*services.AuthTokens, error) {
				return nil, leakyInternalError()
			}},
			body:               `{"username":"stubuser","password":"hunter2hunter2"}`,
			wantStatus:         http.StatusInternalServerError,
			wantSuccess:        false,
			wantError:          "internal server error",
			wantNoInternalLeak: true,
		},
		{
			name:     "login internal failure returns a generic 500",
			endpoint: login,
			svc: &stubAuthService{loginFn: func(_ context.Context, _ *models.LoginRequest) (*services.AuthTokens, error) {
				return nil, leakyInternalError()
			}},
			body:               `{"username":"stubuser","password":"hunter2hunter2"}`,
			wantStatus:         http.StatusInternalServerError,
			wantSuccess:        false,
			wantError:          "internal server error",
			wantNoInternalLeak: true,
		},
		{
			name:               "refresh internal failure returns a generic 500",
			endpoint:           refresh,
			svc:                &stubAuthService{refreshTokenFn: func(_ context.Context, _ string) (*services.AuthTokens, error) { return nil, leakyInternalError() }},
			body:               `{"refresh_token":"whatever"}`,
			wantStatus:         http.StatusInternalServerError,
			wantSuccess:        false,
			wantError:          "internal server error",
			wantNoInternalLeak: true,
		},
		{
			name:               "logout internal failure returns a generic 500",
			endpoint:           logout,
			svc:                &stubAuthService{logoutFn: func(_ context.Context, _ string) error { return leakyInternalError() }},
			body:               `{"refresh_token":"whatever"}`,
			wantStatus:         http.StatusInternalServerError,
			wantSuccess:        false,
			wantError:          "internal server error",
			wantNoInternalLeak: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewAuthHandler(tc.svc, nil, nil, nil, nil, nil, nil)

			req := httptest.NewRequest(http.MethodPost, "/api/auth/x", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			if tc.clientHint != "" {
				req.Header.Set(clientHintHeader, tc.clientHint)
			}
			if tc.cookie != "" {
				req.AddCookie(&http.Cookie{Name: refreshCookieName, Value: tc.cookie})
			}

			rec := httptest.NewRecorder()
			tc.endpoint(h)(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}

			raw := rec.Body.String()

			var env pkg.APIResponse
			if err := json.Unmarshal([]byte(raw), &env); err != nil {
				t.Fatalf("response is not a pkg.APIResponse envelope: %v (body %s)", err, raw)
			}
			if env.Success != tc.wantSuccess {
				t.Errorf("success = %v, want %v (body %s)", env.Success, tc.wantSuccess, raw)
			}
			if tc.wantError != "" && env.Error != tc.wantError {
				t.Errorf("error = %q, want %q", env.Error, tc.wantError)
			}
			if tc.wantSuccess && env.Error != "" {
				t.Errorf("success response carries an error field %q", env.Error)
			}

			if tc.wantAccessToken != "" {
				data, ok := env.Data.(map[string]any)
				if !ok {
					t.Fatalf("data is not an object: %#v", env.Data)
				}
				if got, _ := data["access_token"].(string); got != tc.wantAccessToken {
					t.Errorf("data.access_token = %q, want %q", got, tc.wantAccessToken)
				}
				// The refresh token ships in the HttpOnly cookie only
				// (AuthTokens.RefreshToken is json:"-"). A body copy would
				// hand the long-lived credential to anything that can read
				// the response.
				if _, present := data["refresh_token"]; present {
					t.Errorf("refresh_token leaked into the JSON body: %s", raw)
				}
				if strings.Contains(raw, stubRefreshToken) {
					t.Errorf("refresh token value appears in the body: %s", raw)
				}
			}

			if tc.wantNoInternalLeak {
				for _, frag := range leakyInternalErrorFragments {
					if strings.Contains(strings.ToLower(raw), strings.ToLower(frag)) {
						t.Errorf("internal error fragment %q leaked to the client: %s", frag, raw)
					}
				}
			}
		})
	}
}

// TestAuthHandler_SuccessAlwaysIssuesBothCookies pins the pairing that the
// upload/download gate depends on: every token-issuing endpoint must set the
// media cookie alongside the refresh cookie. If Register/Login/Refresh ever
// stopped issuing it, browser <img> loads of channel and DM attachments would
// start 401ing and the client would silently swap every image for a generic
// file card — the symptom is far from the cause, so it is pinned here.
func TestAuthHandler_SuccessAlwaysIssuesBothCookies(t *testing.T) {
	endpoints := []struct {
		name     string
		endpoint func(h *AuthHandler) http.HandlerFunc
		body     string
	}{
		{"Register", register, `{"username":"stubuser","password":"hunter2hunter2"}`},
		{"Login", login, `{"username":"stubuser","password":"hunter2hunter2"}`},
		{"Refresh", refresh, `{"refresh_token":"old-token"}`},
	}

	for _, ep := range endpoints {
		t.Run(ep.name, func(t *testing.T) {
			h := NewAuthHandler(&stubAuthService{}, nil, nil, nil, nil, nil, nil)
			req := httptest.NewRequest(http.MethodPost, "/api/auth/x", strings.NewReader(ep.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			ep.endpoint(h)(rec, req)

			media := requireOneSetCookie(t, rec, mediaCookieName)
			if media.Value == "" {
				t.Error("media cookie has an empty value")
			}
			if !media.HttpOnly || !media.Secure {
				t.Errorf("media cookie must be HttpOnly+Secure, got HttpOnly=%v Secure=%v", media.HttpOnly, media.Secure)
			}
			if media.Path != "/api/uploads" {
				t.Errorf("media cookie Path = %q, want /api/uploads", media.Path)
			}
			// SameSite=None is required for cross-scheme <img> loads from the
			// Electron/Capacitor shells — see setMediaCookie.
			if media.SameSite != http.SameSiteNoneMode {
				t.Errorf("media cookie SameSite = %s, want None", sameSiteName(media.SameSite))
			}
			assertRefreshCookieShape(t, requireOneSetCookie(t, rec, refreshCookieName))
		})
	}
}

// TestAuthHandler_MediaTokenFailureDoesNotFailLogin: minting the media cookie
// is best-effort. A signing failure degrades inline image rendering (the
// client falls back to authenticated fetch) but must never turn a
// degraded-images problem into a cannot-sign-in problem.
func TestAuthHandler_MediaTokenFailureDoesNotFailLogin(t *testing.T) {
	h := NewAuthHandler(&noMediaTokenAuthService{}, nil, nil, nil, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"username":"stubuser","password":"hunter2hunter2"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Login(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 despite media-token failure (body %s)", rec.Code, rec.Body.String())
	}
	if got := findSetCookies(t, rec, mediaCookieName); len(got) != 0 {
		t.Errorf("expected no media cookie when minting failed, got %d", len(got))
	}
	// The session itself must still be established.
	if c := requireOneSetCookie(t, rec, refreshCookieName); c.Value != stubRefreshToken {
		t.Errorf("refresh cookie = %q, want %q", c.Value, stubRefreshToken)
	}
}

// noMediaTokenAuthService is the stub with a broken media-token minter.
type noMediaTokenAuthService struct {
	stubAuthService
}

func (n *noMediaTokenAuthService) GenerateMediaToken(_ string) (string, error) {
	return "", fmt.Errorf("signing key unavailable")
}

var _ services.AuthService = (*noMediaTokenAuthService)(nil)
