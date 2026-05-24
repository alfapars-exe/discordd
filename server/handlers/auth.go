package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
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

// refreshCookieTTL keeps the cookie alive as long as the server-side refresh
// token. Setting a Max-Age here lets browsers proactively expire it; the
// server still revokes via the sessions table when the user logs out.
const refreshCookieTTL = 30 * 24 * time.Hour

// setRefreshCookie writes the refresh token as an HttpOnly + SameSite=Strict
// cookie. The token is still echoed in the JSON body so non-cookie clients
// (mobile native, automated tests, the iOS Capacitor shell which sometimes
// strips set-cookie) keep working — this is a graceful migration, not a
// hard cutover. The browser/Electron client is expected to ignore the body
// value and rely on the cookie.
//
// Secure is set unconditionally: production traffic terminates at HTTPS
// (Caddy in the install script), and on plain http://localhost browsers
// already exempt secure-only cookies for development.
func setRefreshCookie(w http.ResponseWriter, refreshToken string) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    refreshToken,
		Path:     "/api/auth",
		MaxAge:   int(refreshCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// clearRefreshCookie expires the refresh cookie on logout.
func clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/api/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// extractRefreshToken returns the refresh token from the request, preferring
// the HttpOnly cookie over the body. Body fallback is retained so existing
// mobile/native clients keep working through the migration window. Once all
// official clients are updated, the body path can be removed.
func extractRefreshToken(r *http.Request, bodyToken string) string {
	if cookie, err := r.Cookie(refreshCookieName); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	return bodyToken
}

type AuthHandler struct {
	authService      services.AuthService
	loginLimiter     *ratelimit.LoginRateLimiter
	registerLimiter  *ratelimit.LoginRateLimiter
	forgotPwdLimiter *ratelimit.LoginRateLimiter
	resetPwdLimiter  *ratelimit.LoginRateLimiter
}

// NewAuthHandler creates a new AuthHandler. All limiters may be nil to disable rate limiting.
func NewAuthHandler(
	authService services.AuthService,
	loginLimiter *ratelimit.LoginRateLimiter,
	registerLimiter *ratelimit.LoginRateLimiter,
	forgotPwdLimiter *ratelimit.LoginRateLimiter,
	resetPwdLimiter *ratelimit.LoginRateLimiter,
) *AuthHandler {
	return &AuthHandler{
		authService:      authService,
		loginLimiter:     loginLimiter,
		registerLimiter:  registerLimiter,
		forgotPwdLimiter: forgotPwdLimiter,
		resetPwdLimiter:  resetPwdLimiter,
	}
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

	setRefreshCookie(w, tokens.RefreshToken)
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

	setRefreshCookie(w, tokens.RefreshToken)
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
	setRefreshCookie(w, tokens.RefreshToken)
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
			pkg.Error(w, err)
			return
		}
	}

	clearRefreshCookie(w)
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

	cooldown, err := h.authService.ForgotPassword(r.Context(), req.Email)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if cooldown > 0 {
		pkg.JSON(w, http.StatusOK, map[string]any{
			"message":  "cooldown active",
			"cooldown": cooldown,
		})
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
