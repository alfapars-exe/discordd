package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// AuthAppLogger writes structured logs. ISP to avoid circular dependency.
type AuthAppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

type AuthService interface {
	Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error)
	Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error)
	Logout(ctx context.Context, refreshToken string) error
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
	ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error
	ChangeEmail(ctx context.Context, userID, password, newEmail string) error

	// ForgotPassword sends a password reset email.
	// Returns silently if email doesn't exist (email enumeration protection).
	// Cooldown: 1 request per 90s per email. cooldownRemaining > 0 = seconds left.
	ForgotPassword(ctx context.Context, email string) (cooldownRemaining int, err error)

	// ResetPassword validates token, updates password, and deletes token (one-time use).
	ResetPassword(ctx context.Context, token, newPassword string) error

	SetAppLogger(logger AuthAppLogger)
}

type AuthTokens struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	User         models.User `json:"user"`
}

type authService struct {
	userRepo    repository.UserRepository
	sessionRepo repository.SessionRepository
	resetRepo   repository.PasswordResetRepository // nil if email not configured
	hub         ws.EventPublisher
	emailSender email.EmailSender // nil if RESEND_API_KEY not set
	appLogger   AuthAppLogger
	jwtSecret   []byte
	accessExp   time.Duration
	refreshExp  time.Duration

	// usedRefreshTokens remembers refresh tokens we've already consumed
	// (rotated out of the sessions table) for refreshExp + small buffer.
	// If a second refresh request arrives with the same token, that's a
	// reuse attempt — almost always means the token was leaked. We
	// invalidate every session for that user as defense in depth.
	usedRefreshMu sync.Mutex
	usedRefresh   map[string]usedRefreshEntry
}

// usedRefreshEntry records a recently-consumed refresh token. We store the
// owning user ID so the reuse-detection path can blast all their sessions
// without re-querying the DB (the token's session row is already gone).
type usedRefreshEntry struct {
	userID    string
	expiresAt time.Time
}

func (s *authService) SetAppLogger(logger AuthAppLogger) {
	s.appLogger = logger
}

func (s *authService) logWarn(userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(models.LogLevelWarn, models.LogCategoryAuth, userID, nil, message, metadata)
	}
}

func NewAuthService(
	userRepo repository.UserRepository,
	sessionRepo repository.SessionRepository,
	resetRepo repository.PasswordResetRepository,
	hub ws.EventPublisher,
	emailSender email.EmailSender,
	jwtSecret string,
	accessExpMinutes int,
	refreshExpDays int,
) AuthService {
	s := &authService{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		resetRepo:   resetRepo,
		hub:         hub,
		emailSender: emailSender,
		jwtSecret:   []byte(jwtSecret),
		accessExp:   time.Duration(accessExpMinutes) * time.Minute,
		refreshExp:  time.Duration(refreshExpDays) * 24 * time.Hour,
		usedRefresh: make(map[string]usedRefreshEntry, 128),
	}
	// Background sweep so the used-refresh map can't grow unbounded if a
	// large user base actively rotates tokens. Sweep cadence = refreshExp/4
	// is plenty: entries expire long before they'd matter, and the sweep
	// just bounds memory.
	go s.usedRefreshSweepLoop()
	return s
}

// usedRefreshSweepLoop evicts expired entries from usedRefresh once an hour.
// Runs for the life of the process.
func (s *authService) usedRefreshSweepLoop() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		s.usedRefreshMu.Lock()
		for k, v := range s.usedRefresh {
			if now.After(v.expiresAt) {
				delete(s.usedRefresh, k)
			}
		}
		s.usedRefreshMu.Unlock()
	}
}

// hashRefreshToken returns the SHA-256 of a refresh token. Used as the
// map key in usedRefresh so we never store raw tokens in memory longer
// than the single rotation request.
func hashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Register creates a new user account.
// Multi-server: no server membership or role assignment at registration.
// Users join servers via invite or create their own.
func (s *authService) Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	var displayName *string
	if req.DisplayName != "" {
		displayName = &req.DisplayName
	}

	var email *string
	if req.Email != "" {
		email = &req.Email

		// Prevent banned users from re-registering with the same email
		banned, banErr := s.userRepo.IsEmailPlatformBanned(ctx, req.Email)
		if banErr != nil {
			return nil, fmt.Errorf("failed to check email ban: %w", banErr)
		}
		if banned {
			return nil, fmt.Errorf("%w: this email is not allowed", pkg.ErrForbidden)
		}
	}

	user := &models.User{
		Username:     req.Username,
		DisplayName:  displayName,
		Email:        email,
		PasswordHash: string(hash),
		Status:       models.UserStatusOnline,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err
	}

	tokens, err := s.generateTokens(ctx, user)
	if err != nil {
		return nil, err
	}

	return tokens, nil
}

// Login authenticates a user. Platform-level ban checked here; server bans checked at WS connect.
func (s *authService) Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	user, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		s.logWarn(&user.ID, "Login failed: invalid password", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if user.IsPlatformBanned {
		s.logWarn(&user.ID, "Login blocked: account suspended", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}

	if err := s.userRepo.UpdateStatus(ctx, user.ID, models.UserStatusOnline); err != nil {
		return nil, fmt.Errorf("failed to update status: %w", err)
	}
	user.Status = models.UserStatusOnline

	return s.generateTokens(ctx, user)
}

func (s *authService) RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error) {
	tokenHash := hashRefreshToken(refreshToken)

	session, err := s.sessionRepo.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			// Token isn't in the active sessions table. Either it expired
			// and was cleaned up, or it was rotated out by a previous
			// refresh. The latter case is the dangerous one — refresh
			// token reuse strongly suggests theft. Check the recent
			// rotation cache.
			s.usedRefreshMu.Lock()
			entry, wasUsed := s.usedRefresh[tokenHash]
			s.usedRefreshMu.Unlock()
			if wasUsed && time.Now().Before(entry.expiresAt) {
				// Reuse detected. The legitimate session already rotated
				// away from this token; anyone presenting it now is
				// almost certainly the attacker. Kill every session for
				// this user and bump their token_version so any access
				// token the attacker holds is dead on the next request.
				log.Printf("[auth] SECURITY: refresh token reuse detected for user %s — invalidating all sessions", entry.userID)
				s.logWarn(&entry.userID, "Refresh token reuse detected — all sessions invalidated", nil)
				_ = s.sessionRepo.DeleteByUserID(ctx, entry.userID)
				_ = s.userRepo.IncrementTokenVersion(ctx, entry.userID)
				return nil, fmt.Errorf("%w: token reuse detected, all sessions invalidated", pkg.ErrUnauthorized)
			}
			return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if time.Now().After(session.ExpiresAt) {
		if delErr := s.sessionRepo.DeleteByID(ctx, session.ID); delErr != nil {
			return nil, fmt.Errorf("failed to delete expired session: %w", delErr)
		}
		return nil, fmt.Errorf("%w: refresh token expired", pkg.ErrUnauthorized)
	}

	if err := s.sessionRepo.DeleteByID(ctx, session.ID); err != nil {
		return nil, fmt.Errorf("failed to delete old session: %w", err)
	}

	// Mark this token as consumed so a second presentation triggers the
	// reuse-detection branch above. Window matches the refresh token's
	// original TTL — anything older than that is uninteresting because
	// it would fail expiry checks anyway.
	s.usedRefreshMu.Lock()
	s.usedRefresh[tokenHash] = usedRefreshEntry{
		userID:    session.UserID,
		expiresAt: time.Now().Add(s.refreshExp),
	}
	s.usedRefreshMu.Unlock()

	user, err := s.userRepo.GetByID(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	if user.IsPlatformBanned {
		s.logWarn(&user.ID, "Token refresh blocked: account suspended", map[string]string{
			"username": user.Username,
		})
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}

	return s.generateTokens(ctx, user)
}

func (s *authService) Logout(ctx context.Context, refreshToken string) error {
	session, err := s.sessionRepo.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil
		}
		return err
	}

	if err := s.userRepo.UpdateStatus(ctx, session.UserID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return s.sessionRepo.DeleteByID(ctx, session.ID)
}

func (s *authService) ValidateAccessToken(tokenString string) (*models.TokenClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &models.TokenClaims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("%w: invalid token", pkg.ErrUnauthorized)
	}

	claims, ok := token.Claims.(*models.TokenClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("%w: invalid token claims", pkg.ErrUnauthorized)
	}

	// Token-version (revocation) check: a "logout from all devices" bumps
	// users.token_version, which makes every outstanding access token's
	// tv claim < current version → rejected here.
	//
	// Legacy tokens issued before migration 066 have no tv claim, which
	// decodes to TokenVersion=0. New users also start at token_version=0,
	// so legacy tokens validate cleanly until their first
	// revocation event. Background DB read is unavoidable; the user_cache
	// in AuthMiddleware absorbs the load.
	user, err := s.userRepo.GetByID(context.Background(), claims.UserID)
	if err != nil {
		// Treat missing-user as an invalid token. Returning the raw lookup
		// error would leak DB shape to clients.
		return nil, fmt.Errorf("%w: user not found", pkg.ErrUnauthorized)
	}
	if claims.TokenVersion < user.TokenVersion {
		return nil, fmt.Errorf("%w: token revoked (logged out from all devices)", pkg.ErrUnauthorized)
	}

	return claims, nil
}

// ChangePassword sets a new password for the authenticated user. The session
// is the proof-of-identity; we don't re-verify the current password.
// ChangePassword updates the user's password after verifying the current one.
//
// Verifying currentPassword (not just the JWT) protects against:
//   - Stolen access tokens — attacker with the JWT alone can't lock the user out
//   - Brief unattended-session takeover (shared device, kiosk, screen-share)
//   - XSS-exfiltrated tokens — the attacker still needs the password
//
// Re-asking for the password on top of an authenticated session is the
// industry standard (Discord, Slack, GitHub, Google all do this). The minor
// UX friction is worth the defense-in-depth.
func (s *authService) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	if len(newPassword) < 6 {
		return fmt.Errorf("%w: password must be at least 6 characters", pkg.ErrBadRequest)
	}
	if currentPassword == "" {
		return fmt.Errorf("%w: current password is required", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		s.logWarn(&userID, "password change attempted with wrong current password", nil)
		return fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	if err := s.userRepo.UpdatePassword(ctx, userID, string(newHash)); err != nil {
		return err
	}

	// Bump token_version so every outstanding JWT for this user is
	// invalidated immediately. A password change is the strongest signal
	// the user wants to lock out all current sessions — anything still
	// using the old credentials (including the attacker who triggered
	// the change) gets booted. Best-effort: if the bump fails, the
	// password is still changed (caller's primary intent), we just log.
	if err := s.userRepo.IncrementTokenVersion(ctx, userID); err != nil {
		log.Printf("[auth] WARN failed to bump token_version after password change for %s: %v", userID, err)
	}

	return nil
}

func (s *authService) ChangeEmail(ctx context.Context, userID, password, newEmail string) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return fmt.Errorf("%w: password is incorrect", pkg.ErrUnauthorized)
	}

	if strings.TrimSpace(newEmail) == "" {
		if user.Email == nil {
			return fmt.Errorf("%w: no email to remove", pkg.ErrBadRequest)
		}
		return s.userRepo.UpdateEmail(ctx, userID, nil)
	}

	newEmail = strings.TrimSpace(newEmail)
	if !models.EmailRegex().MatchString(newEmail) {
		return fmt.Errorf("%w: invalid email format", pkg.ErrBadRequest)
	}

	if user.Email != nil && *user.Email == newEmail {
		return fmt.Errorf("%w: new email is the same as current email", pkg.ErrBadRequest)
	}

	return s.userRepo.UpdateEmail(ctx, userID, &newEmail)
}

// ─── Password Reset ───

const resetCooldown = 90 * time.Second
const resetTokenExpiry = 20 * time.Minute

// ForgotPassword sends a reset email. Token stored as SHA256 hash in DB.
// Email enumeration protection: returns success even if email not found.
func (s *authService) ForgotPassword(ctx context.Context, emailAddr string) (int, error) {
	if s.emailSender == nil || s.resetRepo == nil {
		return 0, fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByEmail(ctx, emailAddr)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return 0, nil
		}
		return 0, fmt.Errorf("failed to look up user: %w", err)
	}

	// Cooldown check
	lastToken, err := s.resetRepo.GetLatestByUserID(ctx, user.ID)
	if err == nil {
		elapsed := time.Since(lastToken.CreatedAt)
		if elapsed < resetCooldown {
			remaining := int((resetCooldown - elapsed).Seconds())
			if remaining < 1 {
				remaining = 1
			}
			return remaining, nil
		}
	}

	// Clean up old tokens for this user
	if delErr := s.resetRepo.DeleteByUserID(ctx, user.ID); delErr != nil {
		log.Printf("[auth] warning: failed to delete old reset tokens for user %s: %v", user.ID, delErr)
	}

	// Opportunistic cleanup of all expired tokens
	if delErr := s.resetRepo.DeleteExpired(ctx); delErr != nil {
		log.Printf("[auth] warning: failed to delete expired reset tokens: %v", delErr)
	}

	// Generate token (32 bytes = 64 hex chars)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return 0, fmt.Errorf("failed to generate reset token: %w", err)
	}
	plainToken := hex.EncodeToString(tokenBytes)

	// Store SHA256 hash in DB
	hashBytes := sha256.Sum256([]byte(plainToken))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken := &models.PasswordResetToken{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(resetTokenExpiry),
	}
	if err := s.resetRepo.Create(ctx, resetToken); err != nil {
		return 0, fmt.Errorf("failed to store reset token: %w", err)
	}

	// Send email with plaintext token
	if err := s.emailSender.SendPasswordReset(ctx, emailAddr, plainToken); err != nil {
		return 0, fmt.Errorf("failed to send reset email: %w", err)
	}

	log.Printf("[auth] password reset email sent to user %s", user.ID)
	return 0, nil
}

// ResetPassword validates the token, updates the password, and deletes all tokens for the user.
func (s *authService) ResetPassword(ctx context.Context, token, newPassword string) error {
	if s.resetRepo == nil {
		return fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	if len(newPassword) < 8 {
		return fmt.Errorf("%w: password must be at least 8 characters", pkg.ErrBadRequest)
	}

	hashBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken, err := s.resetRepo.GetByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to look up reset token: %w", err)
	}

	if time.Now().After(resetToken.ExpiresAt) {
		if delErr := s.resetRepo.DeleteByID(ctx, resetToken.ID); delErr != nil {
			log.Printf("[auth] warning: failed to delete expired token %s: %v", resetToken.ID, delErr)
		}
		return fmt.Errorf("%w: reset token has expired", pkg.ErrBadRequest)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	if err := s.userRepo.UpdatePassword(ctx, resetToken.UserID, string(newHash)); err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	// Delete all tokens for this user (one-time use)
	if err := s.resetRepo.DeleteByUserID(ctx, resetToken.UserID); err != nil {
		log.Printf("[auth] warning: failed to delete reset tokens for user %s: %v", resetToken.UserID, err)
	}

	log.Printf("[auth] password reset completed for user %s", resetToken.UserID)
	return nil
}

// ─── Private Helpers ───

func (s *authService) generateTokens(ctx context.Context, user *models.User) (*AuthTokens, error) {
	now := time.Now()
	// Embed the current token_version so future "logout from all devices"
	// can invalidate this token by bumping users.token_version above the
	// embedded value. See ValidateAccessToken + migration 066.
	accessClaims := &models.TokenClaims{
		UserID:       user.ID,
		Username:     user.Username,
		TokenVersion: user.TokenVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.accessExp)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}

	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessString, err := accessToken.SignedString(s.jwtSecret)
	if err != nil {
		return nil, fmt.Errorf("failed to sign access token: %w", err)
	}

	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	refreshString := hex.EncodeToString(refreshBytes)

	session := &models.Session{
		UserID:       user.ID,
		RefreshToken: refreshString,
		ExpiresAt:    now.Add(s.refreshExp),
	}

	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	user.PasswordHash = ""

	return &AuthTokens{
		AccessToken:  accessString,
		RefreshToken: refreshString,
		User:         *user,
	}, nil
}
