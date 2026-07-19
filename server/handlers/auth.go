package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// refreshCookieName is the HttpOnly cookie that carries the refresh token
// when the client is browser/Electron-based. Cookie storage moves the
// long-lived token out of reach of XSS (vs. localStorage, where any script
// running in the renderer can read it).
const refreshCookieName = "hichat_refresh"

// clientHintHeader is sent by every official HiChat client on every API
// call, carrying "electron", "capacitor", or "web". It has two jobs:
//
//  1. It tells setRefreshCookie whether the caller is a native shell, which
//     decides the cookie's SameSite attribute (see below).
//  2. Its mere PRESENCE is the CSRF gate on the cookie path — see
//     extractRefreshToken.
//
// It must be listed in the CORS AllowedHeaders (server/bootstrap.go) or the
// preflight rejects it and no client can send it.
const clientHintHeader = "X-HiChat-Client"

// isNativeClient reports whether the request came from one of our packaged
// native shells, which run under custom schemes (app://hichat for Electron,
// capacitor://localhost and friends for mobile) and therefore talk to the
// API cross-site.
//
// Unknown values deliberately fall through to false: this header is a hint
// from our own clients, and an unrecognised value must never be able to
// downgrade a web session's cookie to a weaker SameSite.
func isNativeClient(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get(clientHintHeader))) {
	case "electron", "capacitor":
		return true
	default:
		return false
	}
}

// refreshCookieSameSite picks the SameSite attribute for the refresh cookie.
//
// Native shells get None; browsers get Strict. This is not a preference, it
// is a hard requirement for the desktop app to work at all: the packaged
// Electron renderer's origin is app://hichat while the API is on a different
// host, so every response that sets this cookie is a CROSS-SITE response,
// and Chromium rejects SameSite=Strict cookies at SET time on those. The
// desktop app was never storing hichat_refresh — registration and login
// appeared to succeed (the access token arrives in the JSON body) but the
// next launch had no refresh cookie, so /api/users/me 401'd, /api/auth/refresh
// had nothing to send, and the user was bounced to /login. That is the
// ".exe registration doesn't persist" report.
//
// The same reasoning already forced the media cookie to None — see the long
// rationale on setMediaCookie.
//
// Cookie identity is (name, domain, path); SameSite is not part of it, so
// both variants coexist under one name and each client's jar simply holds
// whichever variant it was served.
//
// The CSRF exposure that SameSite=None normally reopens is closed by the
// header gate in extractRefreshToken.
func refreshCookieSameSite(r *http.Request) http.SameSite {
	if isNativeClient(r) {
		return http.SameSiteNoneMode
	}
	return http.SameSiteStrictMode
}

// refreshCookieTTL keeps the cookie alive as long as the server-side refresh
// token. Setting a Max-Age here lets browsers proactively expire it; the
// server still revokes via the sessions table when the user logs out.
const refreshCookieTTL = 30 * 24 * time.Hour

// setRefreshCookie writes the refresh token as an HttpOnly cookie whose
// SameSite attribute depends on the calling client (see
// refreshCookieSameSite). The token is still echoed in the JSON body so
// non-cookie clients (mobile native, automated tests, the iOS Capacitor
// shell which sometimes strips set-cookie) keep working — this is a graceful
// migration, not a hard cutover. The browser/Electron client is expected to
// ignore the body value and rely on the cookie.
//
// Secure is set unconditionally: production traffic terminates at HTTPS
// (Caddy in the install script), and on plain http://localhost browsers
// already exempt secure-only cookies for development. It is also a hard
// prerequisite for SameSite=None, which browsers reject without it.
func setRefreshCookie(w http.ResponseWriter, r *http.Request, refreshToken string) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    refreshToken,
		Path:     "/api/auth",
		MaxAge:   int(refreshCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: refreshCookieSameSite(r),
	})
}

// clearRefreshCookie expires the refresh cookie on logout.
//
// It emits BOTH SameSite variants. A clearing cookie is still a Set-Cookie,
// so it is subject to the same browser acceptance rules as the original: a
// Strict-only clear is rejected outright on a cross-site logout response,
// which would leave a live refresh cookie sitting in the desktop app's jar
// after the user pressed "log out". Emitting both means whichever variant
// the jar accepts performs the deletion, and since both are deletions
// (empty value, negative Max-Age) the order they land in is irrelevant.
//
// Emitting both unconditionally — rather than mirroring the request — also
// covers a client whose stored variant does not match what it would be
// served today (e.g. a shell upgraded across this change).
func clearRefreshCookie(w http.ResponseWriter) {
	for _, sameSite := range []http.SameSite{http.SameSiteNoneMode, http.SameSiteStrictMode} {
		http.SetCookie(w, &http.Cookie{
			Name:     refreshCookieName,
			Value:    "",
			Path:     "/api/auth",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   true,
			SameSite: sameSite,
		})
	}
}

// mediaCookieTTL is the media cookie's Max-Age. It MUST equal
// services.MediaTokenTTL — the cookie's whole job is to deliver that token,
// so a cookie outliving its contents is a cookie that authenticates nothing.
//
// It previously reused refreshCookieTTL (30 days) while carrying an access
// token that expires far sooner (JWT_ACCESS_EXPIRY_MINUTES, 24h by default,
// and operators are encouraged to tighten it). The mismatch is the
// file-preview bug: a tab idle past the
// access token's expiry still had the cookie, still sent it, and every
// attachment came back 401 — the client's <img onError> then swapped each
// image for a generic file card.
const mediaCookieTTL = services.MediaTokenTTL

// setMediaCookie writes a media-scoped token as an HttpOnly cookie scoped to
// /api/uploads so browser <img>/<video> tags (which can't send an
// Authorization header) can authenticate to the attachment download endpoint
// (F-1). Consumer: handlers/upload_download.go (mediaCookieName, Serve).
//
// The value is deliberately NOT the API access token. Because this cookie is
// SameSite=None (see below) it travels on cross-site subresource loads and is
// correspondingly easy to leak; carrying the access token meant a leak was a
// full API credential, replayable as `Authorization: Bearer` or a WebSocket
// `?token=`. It now carries a scope=media JWT, which AuthMiddleware and the WS
// upgrade path both reject — see services.AuthService.GenerateMediaToken.
//
// SameSite=None is deliberate here (was Strict before). The Electron desktop
// renderer runs under the `app://hichat` custom scheme and the Capacitor
// mobile shells under `capacitor://`/`ionic://`; a chat message that carries
// an `<img src="https://<api-host>/api/uploads/…">` is a cross-site
// SUBRESOURCE from Chromium's point of view, and SameSite=Strict (and even
// Lax, post-Chrome 91) blocks cookies on those. That silently 401s every
// channel/DM image attachment so the client's <img onError> handler swaps
// the tile for a generic file card — the exact symptom reported in-app.
//
// The CSRF exposure this reopens is negligible for this specific cookie:
//   - Path=/api/uploads narrows the cookie to a single GET-only handler.
//   - Serve is idempotent (no side effects) — the classic CSRF risk of
//     "attacker forces a state change with victim's credentials" doesn't apply.
//   - Upload URLs carry an 8-byte random prefix so they're not enumerable.
//   - Serve re-checks channel-read / DM-participant permissions before
//     streaming bytes, so leaking the cookie to a cross-site fetch still
//     can't reach content the user wasn't authorized to see.
//   - Cross-origin JS can't read the response body (no ACAO for this handler),
//     so an attacker page can at most cause a bandwidth burn on a known URL.
func setMediaCookie(w http.ResponseWriter, mediaToken string) {
	http.SetCookie(w, &http.Cookie{
		Name:     mediaCookieName,
		Value:    mediaToken,
		Path:     "/api/uploads",
		MaxAge:   int(mediaCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode,
	})
}

// issueMediaCookie mints a fresh media token for userID and writes it as the
// media cookie. Called on login, register, and refresh so an active session's
// cookie is continuously renewed and never reaches MediaTokenTTL.
//
// A signing failure is logged and swallowed: the media cookie is a
// convenience for inline <img> rendering, and failing the whole login over it
// would turn a degraded-images problem into a can't-sign-in problem. The user
// lands authenticated with a working API session; attachments fall back to
// the client's authenticated-fetch path.
func (h *AuthHandler) issueMediaCookie(w http.ResponseWriter, userID string) {
	mediaToken, err := h.authService.GenerateMediaToken(userID)
	if err != nil {
		log.Printf("[auth] media token generation failed for user %s: %v", userID, err)
		return
	}
	setMediaCookie(w, mediaToken)
}

// clearMediaCookie expires the media cookie on logout.
func clearMediaCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     mediaCookieName,
		Value:    "",
		Path:     "/api/uploads",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteNoneMode,
	})
}

// extractRefreshToken returns the refresh token from the request, preferring
// the HttpOnly cookie over the body. Body fallback is retained so existing
// mobile/native clients keep working through the migration window. Once all
// official clients are updated, the body path can be removed.
//
// ─── CSRF gate ───
//
// The COOKIE is only honoured when the request carries an X-HiChat-Client
// header (any value). This is what makes SameSite=None safe for this cookie.
//
// A cross-site attacker page can cause the victim's browser to send a
// SameSite=None cookie on a "simple" request — a form POST, an <img>, a
// no-header fetch. What it cannot do is attach a CUSTOM header to one:
// adding X-HiChat-Client promotes the request out of the simple-request
// category and forces a CORS preflight, and our preflight only answers for
// the first-party origins in the allowlist (server/bootstrap.go). So a
// third-party page can never get past this check.
//
// That closes the two classic SameSite=None risks on these endpoints:
//   - forced rotation: an attacker silently burning the victim's refresh
//     token (RefreshToken rotates and invalidates the old one), logging
//     them out of the desktop app.
//   - logout-CSRF: an attacker terminating the victim's session at will.
//
// The BODY fallback stays deliberately ungated. An attacker cannot read the
// victim's refresh token, so they cannot put one in a request body — the
// body path carries its own proof of possession and needs no origin check.
func extractRefreshToken(r *http.Request, bodyToken string) string {
	if r.Header.Get(clientHintHeader) != "" {
		if cookie, err := r.Cookie(refreshCookieName); err == nil && cookie.Value != "" {
			return cookie.Value
		}
	}
	return bodyToken
}

type AuthHandler struct {
	authService      services.AuthService
	wsTicketService  services.WSTicketService
	loginLimiter     *ratelimit.LoginRateLimiter
	registerLimiter  *ratelimit.LoginRateLimiter
	forgotPwdLimiter *ratelimit.LoginRateLimiter
	resetPwdLimiter  *ratelimit.LoginRateLimiter
	// wsTicketLimiter added 2026-05-27 (P1-BC-07): caps /api/auth/ws-ticket
	// issuance per IP. Without this the in-memory ticket map could grow
	// unbounded under spam, degrading legitimate logins.
	wsTicketLimiter *ratelimit.LoginRateLimiter
}

// NewAuthHandler creates a new AuthHandler. All limiters may be nil to disable rate limiting.
func NewAuthHandler(
	authService services.AuthService,
	wsTicketService services.WSTicketService,
	loginLimiter *ratelimit.LoginRateLimiter,
	registerLimiter *ratelimit.LoginRateLimiter,
	forgotPwdLimiter *ratelimit.LoginRateLimiter,
	resetPwdLimiter *ratelimit.LoginRateLimiter,
	wsTicketLimiter *ratelimit.LoginRateLimiter,
) *AuthHandler {
	return &AuthHandler{
		authService:      authService,
		wsTicketService:  wsTicketService,
		loginLimiter:     loginLimiter,
		registerLimiter:  registerLimiter,
		forgotPwdLimiter: forgotPwdLimiter,
		resetPwdLimiter:  resetPwdLimiter,
		wsTicketLimiter:  wsTicketLimiter,
	}
}

// WSTicket handles POST /api/auth/ws-ticket — issues a one-time,
// ~30-second ticket the client uses to open the WebSocket connection.
// See services/ws_ticket_service.go for the rationale (keeps the
// long-lived JWT out of WS URL query strings and proxy access logs).
func (h *AuthHandler) WSTicket(w http.ResponseWriter, r *http.Request) {
	// IP-based rate limit (audit 2026-05-27, P1-BC-07).
	// Endpoint is auth-gated by middleware so user is already known, but
	// IP-based limit catches a single attacker spinning up many accounts.
	if h.wsTicketLimiter != nil {
		ip := ratelimit.ExtractIP(r)
		if !h.wsTicketLimiter.Allow(ip) {
			retryAfter := h.wsTicketLimiter.RetryAfterSeconds(ip)
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
			pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
				fmt.Sprintf("too many ws-ticket requests, please try again in %s",
					ratelimit.FormatRetryMessage(retryAfter)))
			return
		}
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if h.wsTicketService == nil {
		// Server started without WS ticket service — fall back to the
		// legacy `?token=` path on the WS handler. Returning 503 here
		// would break clients that send the request preflight; a
		// 404 is the cleanest "feature not enabled" signal for them
		// to skip the request and try the legacy path.
		pkg.ErrorWithMessage(w, http.StatusNotFound, "ws ticket service not enabled")
		return
	}
	ticket, err := h.wsTicketService.Issue(user.ID)
	if err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to issue ws ticket", err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"ticket": ticket})
}

// Register handles POST /api/auth/register
// First registered user automatically becomes Owner.
// IP-based rate limiting prevents registration spam.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.registerLimiter != nil && !h.registerLimiter.Allow(ip) {
		retryAfter := h.registerLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many registration attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.CreateUserRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Register(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	setRefreshCookie(w, r, tokens.RefreshToken)
	h.issueMediaCookie(w, tokens.User.ID)
	pkg.JSON(w, http.StatusCreated, tokens)
}

// Login handles POST /api/auth/login
// IP-based rate limiting protects against brute-force. Successful login resets the counter.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.loginLimiter != nil && !h.loginLimiter.Allow(ip) {
		retryAfter := h.loginLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many login attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.LoginRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Login(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if h.loginLimiter != nil {
		h.loginLimiter.Reset(ip)
	}

	setRefreshCookie(w, r, tokens.RefreshToken)
	h.issueMediaCookie(w, tokens.User.ID)
	pkg.JSON(w, http.StatusOK, tokens)
}

// Refresh handles POST /api/auth/refresh.
//
// Reads the refresh token from the HttpOnly cookie first (preferred for
// browser/Electron clients) and falls back to the JSON body for native
// clients that don't manage cookies. Empty body is allowed when the cookie
// is present.
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	// Body is optional now — cookie is the primary path.
	_ = json.NewDecoder(r.Body).Decode(&req)

	refreshToken := extractRefreshToken(r, req.RefreshToken)
	if refreshToken == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	tokens, err := h.authService.RefreshToken(r.Context(), refreshToken)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Rotate the cookie with the new refresh token. Server-side rotation
	// (old token invalidated) is handled by authService.RefreshToken.
	setRefreshCookie(w, r, tokens.RefreshToken)
	h.issueMediaCookie(w, tokens.User.ID)
	pkg.JSON(w, http.StatusOK, tokens)
}

// Logout handles POST /api/auth/logout. Accepts the refresh token from
// cookie or body, invalidates it server-side, and clears the cookie.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	// Body is optional — cookie is primary.
	_ = json.NewDecoder(r.Body).Decode(&req)

	refreshToken := extractRefreshToken(r, req.RefreshToken)
	// Even with no token, clearing the cookie + returning 200 is the
	// expected idempotent UX. The service call is only made when we have
	// something to invalidate.
	if refreshToken != "" {
		if err := h.authService.Logout(r.Context(), refreshToken); err != nil {
			clearRefreshCookie(w)
			clearMediaCookie(w)
			pkg.Error(w, err)
			return
		}
	}

	clearRefreshCookie(w)
	clearMediaCookie(w)
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// Me handles GET /api/users/me (requires auth middleware).
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pkg.JSON(w, http.StatusOK, user)
}

// ChangePassword handles POST /api/users/me/password.
//
// Requires current_password to defend against stolen JWTs (XSS exfil,
// brief unattended-session takeover). The JWT proves an active session,
// but the password proves the legitimate user is at the keyboard. This is
// the industry-standard defense-in-depth (Discord/Slack/GitHub/Google all
// require this).
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.NewPassword == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "new_password is required")
		return
	}

	if req.CurrentPassword == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "current_password is required")
		return
	}

	if err := h.authService.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "password changed"})
}

// ChangeEmail handles PUT /api/users/me/email
// Requires current password. Empty new_email removes the email (sets NULL).
func (h *AuthHandler) ChangeEmail(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ChangeEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ChangeEmail(r.Context(), user.ID, req.Password, req.NewEmail); err != nil {
		pkg.Error(w, err)
		return
	}

	var emailResult *string
	if req.NewEmail != "" {
		emailResult = &req.NewEmail
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"message": "email updated",
		"email":   emailResult,
	})
}

// ForgotPassword handles POST /api/auth/forgot-password
// Returns same success response whether email exists or not (enumeration protection).
// IP-based rate limiting + per-email 90s cooldown.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.forgotPwdLimiter != nil && !h.forgotPwdLimiter.Allow(ip) {
		retryAfter := h.forgotPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many requests, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ForgotPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	// The per-email cooldown is still enforced inside the service (it skips
	// sending a second email), but we no longer surface it to the client.
	// A distinct "cooldown active" response let an attacker distinguish a
	// registered email (cooldown) from an unregistered one (generic message)
	// with two requests — account enumeration. Always return the same
	// generic response regardless of whether the email exists or is cooling
	// down.
	if _, err := h.authService.ForgotPassword(r.Context(), req.Email); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "if the email exists, a reset link has been sent",
	})
}

// ResetPassword handles POST /api/auth/reset-password
// Validates token, updates password, deletes token.
// IP-based rate limiting prevents brute-force token guessing.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.resetPwdLimiter != nil && !h.resetPwdLimiter.Allow(ip) {
		retryAfter := h.resetPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ResetPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ResetPassword(r.Context(), req.Token, req.NewPassword); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "password has been reset successfully",
	})
}

// contextKey is a typed key for context values to avoid collisions.
type contextKey string

const UserContextKey contextKey = "user"

// ServerIDContextKey carries the active server ID, set by ServerMembershipMiddleware.
const ServerIDContextKey contextKey = "server_id"
