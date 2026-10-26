package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// authLogger is shared by auth_service.go and auth_password.go — both
// implement methods on the single authService type.
var authLogger = logx.Component(string(models.LogCategoryAuth))

// AuthAppLogger writes structured logs. ISP to avoid circular dependency.
type AuthAppLogger interface {
	Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

type AuthService interface {
	Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error)
	Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error)
	Logout(ctx context.Context, refreshToken string) error
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)

	// GenerateMediaToken mints a scope=media JWT for the hichat_media
	// cookie. See the implementation for why the media cookie can't just
	// carry the access token.
	GenerateMediaToken(userID string) (string, error)

	ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error
	ChangeEmail(ctx context.Context, userID, password, newEmail string) error

	// ForgotPassword sends a password reset email.
	// Returns silently if the identifier doesn't resolve to an account or the
	// account has no recovery email (enumeration protection).
	// Cooldown: 1 request per 90s per identifier. cooldownRemaining > 0 = seconds left.
	ForgotPassword(ctx context.Context, identifier string) (cooldownRemaining int, err error)

	// ResetPassword validates token, updates password, and deletes token (one-time use).
	ResetPassword(ctx context.Context, token, newPassword string) error

	// LogoutAllDevices revokes every refresh session and disconnects any live
	// WebSocket/voice connection for userID (see revokeAllSessions), then
	// marks the user offline. Backs POST /api/auth/logout-all.
	//
	// Production media cookies are bound to a logical session and lose private
	// attachment access on revocation. Pre-issued LiveKit JWTs are independently
	// valid until voiceTokenTTL if presented directly to the SFU.
	LogoutAllDevices(ctx context.Context, userID string) error

	SetAppLogger(logger AuthAppLogger)

	// SetUserCacheInvalidator wires AuthMiddleware's user-cache invalidator
	// so a credential-lifecycle event (password change/reset, logout-all)
	// drops the cached user row immediately instead of waiting out
	// userCacheTTL. Mirrors AdminUserService.SetUserCacheInvalidator; see
	// its doc comment for why this is a post-construction setter rather
	// than a constructor argument.
	SetUserCacheInvalidator(inv UserCacheInvalidator)

	// SetVoiceDisconnecter wires the voice/screen-share kick used by
	// revokeAllSessions — the same VoiceDisconnecter dependency
	// AdminUserService takes as a constructor argument for its own ban/
	// delete paths (services/admin_user_service.go). VoiceService already
	// exists by the time AuthService is constructed in init_services.go, so
	// nothing forces this to be a setter; it is one anyway, mirroring
	// SetUserCacheInvalidator immediately above, so every optional
	// post-construction AuthService dependency is wired the same way and a
	// caller/test can opt in to only the one(s) it needs. Nil-safe: absent
	// wiring, revokeAllSessions simply skips the voice disconnect.
	SetVoiceDisconnecter(vd VoiceDisconnecter)
}

type AuthTokens struct {
	SessionID   string `json:"-"`
	AccessToken string `json:"access_token"`
	// RefreshToken is delivered to clients exclusively via the
	// HttpOnly+Secure+SameSite=Strict cookie set by setRefreshCookie.
	// `json:"-"` keeps the field populated in-process (handlers read it
	// to write the cookie) but stops it from appearing in the JSON body
	// — clients holding a stolen body or a screen-recorded response
	// can no longer extract the long-lived credential.
	//
	// Native clients that previously relied on the body value should
	// migrate to the cookie; the server still ACCEPTS a body-supplied
	// refresh_token on POST /api/auth/refresh as a transitional path
	// (see extractRefreshToken in handlers/auth.go).
	RefreshToken string      `json:"-"`
	User         models.User `json:"user"`
}

type authService struct {
	authSessions             repository.AuthSessionRepository
	accountLifecycle         repository.AccountLifecycleRepository
	accountAnonymization     repository.AccountAnonymizationRepository
	musicRequesterRetirement MusicRequesterRetirementObserver
	applicationRemoval       repository.ApplicationRemovalRepository
	serverOwnership          repository.ServerOwnershipRepository
	ownershipInvalidator     PermissionInvalidator
	mfa                      *MFAService
	userRepo                 repository.UserRepository
	sessionRepo              repository.SessionRepository
	resetRepo                repository.PasswordResetRepository // nil if email not configured
	hub                      ws.EventPublisher
	emailSender              email.EmailSender // nil if RESEND_API_KEY not set
	appLogger                AuthAppLogger
	jwtSecret                []byte
	accessExp                time.Duration
	refreshExp               time.Duration

	// userInvalidator drops the HTTP auth user-cache on a credential-
	// lifecycle event. Optional (nil-safe): absent wiring, the change
	// still lands within userCacheTTL — this just makes it immediate.
	// Wired post-construction by main.go (see SetUserCacheInvalidator),
	// same pattern as adminUserService.userInvalidator.
	userInvalidator UserCacheInvalidator

	// voiceKit disconnects a user's live voice/screen-share session as part
	// of revokeAllSessions. Optional (nil-safe), wired post-construction —
	// see SetVoiceDisconnecter. Same VoiceDisconnecter ISP interface
	// adminUserService.voiceKit uses (member_service.go).
	voiceKit VoiceDisconnecter

	// usedRefreshTokens remembers refresh tokens we've already consumed
	// (rotated out of the sessions table) for refreshExp + small buffer.
	// If a second refresh request arrives with the same token, that's a
	// reuse attempt — almost always means the token was leaked. We
	// invalidate every session for that user as defense in depth.
	usedRefreshMu  sync.Mutex
	usedRefresh    map[string]usedRefreshEntry
	refreshSweepMu sync.Mutex
	refreshSweep   *authRefreshSweep
}

// usedRefreshEntry records a recently-consumed refresh token. We store the
// owning user ID so the reuse-detection path can blast all their sessions
// without re-querying the DB (the token's session row is already gone).
type usedRefreshEntry struct {
	sessionID string
	rotatedAt time.Time
	userID    string
	expiresAt time.Time
}

func (s *authService) SetAppLogger(logger AuthAppLogger) {
	s.appLogger = logger
}

// SetUserCacheInvalidator wires the auth middleware's user-cache
// invalidator. Called post-construction in main.go because the middleware
// is built after the service layer (it depends on AuthService itself) —
// identical reasoning to adminUserService.SetUserCacheInvalidator.
func (s *authService) SetUserCacheInvalidator(inv UserCacheInvalidator) {
	s.userInvalidator = inv
}

// invalidateUserCache is nil-safe — a no-op until SetUserCacheInvalidator
// has been called.
func (s *authService) invalidateUserCache(userID string) {
	if s.userInvalidator != nil {
		s.userInvalidator.InvalidateUser(userID)
	}
}

// SetVoiceDisconnecter wires the voice/screen-share kick used by
// revokeAllSessions. See the AuthService interface doc for why this is a
// post-construction setter rather than a constructor argument.
func (s *authService) SetVoiceDisconnecter(vd VoiceDisconnecter) {
	s.voiceKit = vd
}

// disconnectVoice is nil-safe — a no-op until SetVoiceDisconnecter has been
// called (main.go wires it once VoiceService exists).
func (s *authService) disconnectVoice(userID string) {
	if s.voiceKit != nil {
		s.voiceKit.DisconnectUser(userID)
	}
}

// revokeAllSessions is the shared "kill every credential we can reach for
// userID" step behind ChangePassword, ResetPassword, and LogoutAllDevices.
// Production WithAuthSessions uses atomic durable revocation; production
// password writes use UpdatePasswordAndRevoke instead. The best-effort legacy
// behavior described below is retained only for unconfigured constructors.
// It: deletes all refresh-session rows (kills the ability to mint new
// access tokens), bumps token_version (kills every unscoped access token
// and WS ticket already in the wild once their gate runs — see
// wsTokenRevoked in ws/handler.go, which the ticket path now shares
// unconditionally with the legacy ?token= path), re-sweeps refresh-session
// rows a second time (see the refresh-race comment below), drops the cached user
// row so the bump is enforced on the very next HTTP request rather than up
// to userCacheTTL later, and disconnects any open WebSocket AND voice/
// screen-share session.
//
// Two credentials deliberately survive this call, both already documented
// at their own mint site and neither broad enough to be a full session:
//   - The scope=media cookie token (GenerateMediaToken) — read-only access
//     to /api/uploads/*, bounded by MediaTokenTTL (7 days). See the "Note on
//     revocation" on GenerateMediaToken.
//   - A LiveKit voice/screen-share JWT (services/voice_token.go) already
//     handed to the client — bounded by voiceTokenTTL (15min). The
//     DisconnectUser call below kicks the live SFU connection immediately
//     (same as admin_user_service.go's ban/delete path), but the JWT itself
//     stays cryptographically valid until its TTL if presented directly to
//     LiveKit without going through this server again.
//
// The WS disconnect step is not redundant with the token_version bump: an
// already-open WebSocket never re-validates its token after the initial
// handshake. Without an explicit disconnect, a revoked session's live
// socket would keep receiving events indefinitely.
//
// Every sub-step is best-effort: a failure is logged but does not stop the
// caller, because by the time this runs the caller's primary intent
// (changing/resetting the password, or an explicit "log out everywhere")
// has already succeeded or is independent of these side effects.
func (s *authService) revokeAllSessions(ctx context.Context, userID string) {
	if s.authSessions != nil {
		if err := s.revokeBoundSessions(ctx, userID); err != nil {
			authLogger.Warn("failed to revoke logical sessions", "user_id", userID)
		}
		return
	}
	if err := s.sessionRepo.DeleteByUserID(ctx, userID); err != nil {
		authLogger.Warn("revokeAllSessions: failed to delete sessions", "user_id", userID, "err", pkg.ErrText(err))
	}
	if err := s.userRepo.IncrementTokenVersion(ctx, userID); err != nil {
		authLogger.Warn("revokeAllSessions: failed to bump token_version", "user_id", userID, "err", pkg.ErrText(err))
	}
	// Refresh-race mitigation (security review 2026-08-01, session-lifecycle
	// finding 2): a refresh request can
	// race the two calls above. If RefreshToken's GetByRefreshToken +
	// DeleteByID (consuming an old, still-valid refresh token) lands AFTER
	// the DeleteByUserID sweep above but its sessionRepo.Create (in
	// generateTokens, minting the replacement session row) lands BEFORE the
	// IncrementTokenVersion bump, the freshly-created session row survives
	// this function and its access token still carries the OLD
	// token_version — reordering the two calls above does not close this,
	// the bad window exists no matter which runs first. Re-sweeping here,
	// AFTER the bump, narrows the window instead of closing it: any session
	// row created between the two DeleteByUserID calls is now caught, and
	// any access token it minted was signed with a token_version that is
	// already stale by the time it's used, so it still dies at the
	// token_version gate. A session row created in the (much smaller) gap
	// between THIS second delete and function return remains a real gap.
	//
	// The durable fix — stamping token_version onto the sessions row itself
	// and rejecting stale stamps in RefreshToken — needs a schema migration
	// and is intentionally left open here (see PROJECT_MEMORY escalation
	// note for the 2026-08-01 session-lifecycle review).
	if err := s.sessionRepo.DeleteByUserID(ctx, userID); err != nil {
		authLogger.Warn("revokeAllSessions: failed to re-sweep sessions after token_version bump", "user_id", userID, "err", pkg.ErrText(err))
	}
	s.invalidateUserCache(userID)
	if s.hub != nil {
		s.hub.DisconnectUser(userID)
	}
	s.disconnectVoice(userID)
}

// Authentication diagnostics retain the caller context for request correlation.
func (s *authService) logWarn(ctx context.Context, userID *string, message string, metadata map[string]string) {
	if !logx.EmitAppEvent(ctx, authLogger, "warn", "auth", userID, nil, message, metadata) && s.appLogger != nil {
		s.appLogger.Log(ctx, models.LogLevelWarn, models.LogCategoryAuth, userID, nil, message, metadata)
	}
}

// logError is reserved for security-critical events (token reuse, account
// compromise indicators). These should trigger alerts in production —
// audit_log queries filtering on LogLevelError + LogCategoryAuth surface them.
// Added 2026-05-27 audit (P0-BC-03).
//
// Also used by Register to leave a durable trail when user/session creation
// fails or partially fails, since those failures are invisible to Sentry via
// a plain 500 alone (see pkg/response.go's Error()) and would otherwise only
// surface as a support ticket about a missing account.
func (s *authService) logError(ctx context.Context, userID *string, message string, metadata map[string]string) {
	if !pkg.ClaimRequestError(ctx) {
		return
	}
	if !logx.EmitAppEvent(ctx, authLogger, "error", "auth", userID, nil, message, metadata) && s.appLogger != nil {
		s.appLogger.Log(ctx, models.LogLevelError, models.LogCategoryAuth, userID, nil, message, metadata)
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
	options ...AuthOption,
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
	for _, option := range options {
		option(s)
	}
	return s
}

// StartAuthMaintenance owns the legacy refresh-cache worker independently of
// request handling. Durable sessions do not use this cache and need no worker.
// Constructors and short-lived test services never start background work.
func StartAuthMaintenance(ctx context.Context, service AuthService) func() {
	s, ok := service.(*authService)
	if !ok || s.authSessions != nil {
		return func() {}
	}
	return s.startRefreshSweep(ctx)
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
		// pkg.ErrText, not err.Error(): CreateUserRequest.Validate() only ever
		// returns fixed, non-request-derived messages (field-name/length
		// text), so this is defense-in-depth rather than a behavior change —
		// consistent with never letting a raw err.Error() reach the 4xx body
		// pkg.Error(w, err) renders this through.
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
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
		// Create explicitly inserts language, so a zero value bypasses its DB
		// default. Return the same privacy default the DB applies on insertion.
		Language:  "en",
		DMPrivacy: "message_request",
	}

	// Refresh token bytes are pure randomness with no DB dependency, so they
	// can be prepared before the transaction opens.
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	refreshString := hex.EncodeToString(refreshBytes)

	session := &models.Session{
		RefreshToken: refreshString,
		ExpiresAt:    time.Now().Add(s.refreshExp),
	}
	if s.authSessions != nil {
		logical, err := newAuthSession(ctx, "", 0, session.ExpiresAt)
		if err != nil {
			return nil, err
		}
		session.AuthSession = logical
	}

	// A4: user row + session row commit atomically (see
	// repository.sqliteUserRepo.CreateWithSession). Before this fix these
	// were separate autocommit statements — a session-insert failure
	// orphaned a committed user row (client saw 500; a retry then hit 409).
	if err := s.userRepo.CreateWithSession(ctx, user, session); err != nil {
		if !errors.Is(err, pkg.ErrAlreadyExists) {
			// pkg.ErrText, not err.Error(): a libSQL connection failure echoes
			// the DSN (incl. authToken) into the driver error, and app_logs is
			// a durable sink rendered in the platform-admin log viewer.
			s.logError(ctx, nil, "Register: user/session creation failed", map[string]string{
				"username": req.Username,
				"error":    pkg.ErrText(err),
			})
		}
		return nil, err
	}

	accessString, err := s.signAccessToken(user, session.AuthSessionID)
	if err != nil {
		// The user+session rows already committed at this point — this is
		// the orphan case: the client sees an error, but the account (and a
		// working refresh session) already exist. logError above/A1 exist
		// to surface exactly this.
		s.logError(ctx, &user.ID, "Register: user committed but access token signing failed", map[string]string{
			"username": req.Username,
			"error":    pkg.ErrText(err),
		})
		return nil, err
	}

	user.PasswordHash = ""

	return &AuthTokens{
		AccessToken:  accessString,
		RefreshToken: refreshString,
		User:         *user,
		SessionID:    session.AuthSessionID,
	}, nil
}

// dummyLoginHash is a valid bcrypt hash (cost 12) compared against the
// supplied password when the username doesn't exist. Without it the
// missing-user path returns almost instantly while the real path spends
// ~80ms in bcrypt — a timing oracle that reveals which usernames are
// registered. Running the same comparison on both paths equalizes the
// response time. Generated once at package load; the input value is
// irrelevant (it never matches a real password).
var dummyLoginHash, _ = bcrypt.GenerateFromPassword([]byte("hichat-login-timing-equalizer"), 12)

// Login authenticates a user. Platform-level ban checked here; server bans checked at WS connect.
func (s *authService) Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		// pkg.ErrText, not err.Error(): LoginRequest.Validate() only ever
		// returns fixed, non-request-derived messages ("username/password is
		// required"), so this is defense-in-depth rather than a behavior
		// change — consistent with never letting a raw err.Error() reach the
		// 4xx body pkg.Error(w, err) renders this through.
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	user, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			// Equalize timing against the wrong-password path below so the
			// response latency can't be used to enumerate valid usernames.
			_ = bcrypt.CompareHashAndPassword(dummyLoginHash, []byte(req.Password))
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		s.logWarn(ctx, &user.ID, "Login failed: invalid password", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if user.IsPlatformBanned {
		s.logWarn(ctx, &user.ID, "Login blocked: account suspended", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}
	var lifecycle *models.AccountLifecycle
	if s.accountLifecycle != nil {
		lifecycle, err = s.accountLifecycle.Get(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		if lifecycle.DisabledAt != nil && !req.Reactivate {
			return nil, ErrAccountDisabled
		}
	}

	if s.mfa != nil {
		if err := s.mfa.CheckLogin(ctx, user.ID, req.MFACode); err != nil {
			return nil, err
		}
	}
	if lifecycle != nil && lifecycle.DisabledAt != nil {
		if s.authSessions == nil {
			return nil, fmt.Errorf("account restoration unavailable")
		}
		user.TokenVersion++
		user.Status = models.UserStatusOnline
		tokens, err := s.generateBoundTokens(ctx, user, lifecycle)
		if err == nil {
			s.invalidateUserCache(user.ID)
		}
		return tokens, err
	}
	if s.authSessions != nil {
		user.Status = models.UserStatusOnline
		return s.generateTokens(ctx, user)
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
				if err := checkExpectedAuthAccount(ctx, entry.userID); err != nil {
					return nil, err
				}
				if entry.sessionID != "" {
					if err := checkExpectedAuthSession(ctx, entry.sessionID); err != nil {
						return nil, err
					}
					// Concurrent tabs may submit the same cookie before its
					// replacement arrives. Never issue it twice, but do not
					// mistake that bounded overlap for a compromise of every
					// session. Later reuse retains the existing kill-all policy.
					if time.Since(entry.rotatedAt) < 5*time.Second {
						return nil, ErrRefreshSuperseded
					}
				}
				// Reuse detected. The legitimate session already rotated
				// away from this token; anyone presenting it now is
				// almost certainly the attacker. Kill every session for
				// this user and bump their token_version so any access
				// token the attacker holds is dead on the next request.
				//
				// Audit 2026-05-27 (P0-BC-03): elevated from Warn to
				// Error and given structured metadata so monitoring can
				// alert specifically on this event. This is a
				// near-certain indicator of credential compromise.
				s.logError(ctx, &entry.userID, "Refresh token reuse detected — all sessions invalidated", map[string]string{
					"event":           "token_compromise_detected",
					"severity":        "critical",
					"action_taken":    "all_sessions_invalidated,token_version_incremented",
					"reuse_window_at": time.Now().UTC().Format(time.RFC3339),
					"original_used":   entry.expiresAt.Add(-s.refreshExp).UTC().Format(time.RFC3339),
				})
				if s.authSessions != nil {
					s.revokeAllSessions(ctx, entry.userID)
				} else {
					_ = s.sessionRepo.DeleteByUserID(ctx, entry.userID)
					_ = s.userRepo.IncrementTokenVersion(ctx, entry.userID)
				}
				return nil, fmt.Errorf("%w: token reuse detected, all sessions invalidated", pkg.ErrUnauthorized)
			}
			return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if err := checkExpectedAuthAccount(ctx, session.UserID); err != nil {
		return nil, err
	}
	if err := checkExpectedAuthSession(ctx, session.AuthSessionID); err != nil {
		return nil, err
	}
	if time.Now().After(session.ExpiresAt) {
		if delErr := s.sessionRepo.DeleteByID(ctx, session.ID); delErr != nil {
			return nil, fmt.Errorf("failed to delete expired session: %w", delErr)
		}
		return nil, fmt.Errorf("%w: refresh token expired", pkg.ErrUnauthorized)
	}
	if s.authSessions != nil {
		return s.refreshBoundTokens(ctx, session)
	}

	if err := s.sessionRepo.DeleteByID(ctx, session.ID); err != nil {
		return nil, fmt.Errorf("failed to delete old session: %w", err)
	}

	// Mark this token as consumed so a second presentation triggers the
	// reuse-detection branch above. Window matches the refresh token's
	// original TTL — anything older than that is uninteresting because
	// it would fail expiry checks anyway.
	//
	// Audit 2026-05-27 (P0-BC-02): trigger emergency eviction when the
	// map grows past usedRefreshEmergencyThreshold so the hourly sweep
	// can't fall behind during a refresh-token storm (DoS attack or
	// just a bursty rollout). Inline eviction holds the mutex briefly
	// but unbounded growth → OOM is the worse failure mode.
	s.usedRefreshMu.Lock()
	s.usedRefresh[tokenHash] = usedRefreshEntry{
		userID:    session.UserID,
		expiresAt: time.Now().Add(s.refreshExp),
	}
	if len(s.usedRefresh) > usedRefreshEmergencyThreshold {
		now := time.Now()
		for k, v := range s.usedRefresh {
			if now.After(v.expiresAt) {
				delete(s.usedRefresh, k)
			}
		}
	}
	s.usedRefreshMu.Unlock()

	user, err := s.userRepo.GetByID(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	if user.IsPlatformBanned {
		s.logWarn(ctx, &user.ID, "Token refresh blocked: account suspended", map[string]string{
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

	if err := checkExpectedAuthAccount(ctx, session.UserID); err != nil {
		return err
	}
	if s.authSessions != nil && session.AuthSessionID != "" {
		if _, err := s.authSessions.Revoke(ctx, session.UserID, session.AuthSessionID, time.Now().Unix()); err != nil {
			return err
		}
		s.disconnectSession(session.UserID, session.AuthSessionID)
		return s.sessionRepo.DeleteByID(ctx, session.ID)
	}
	if err := s.userRepo.UpdateStatus(ctx, session.UserID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return s.sessionRepo.DeleteByID(ctx, session.ID)
}

// LogoutAllDevices revokes every session and outstanding access token for
// userID (see revokeAllSessions) and marks the user offline, mirroring
// Logout's status update. Backs POST /api/auth/logout-all — unlike Logout,
// which invalidates a single refresh token, this ends every session the
// user has anywhere, including the one that called it.
func (s *authService) LogoutAllDevices(ctx context.Context, userID string) error {
	s.revokeAllSessions(ctx, userID)

	if err := s.userRepo.UpdateStatus(ctx, userID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return nil
}

// ValidateAccessToken — JWT-only validation. NO DB read.
//
// Token-version (revocation) and IsPlatformBanned checks moved to the
// callers so they can hit a warm cache instead of bypassing it:
//   - HTTP: AuthMiddleware.Require checks against m.userCache (30s TTL),
//     cutting one DB read per authenticated request.
//   - WebSocket: ws/handler.go HandleConnection already fetches the user
//     row for username/displayName/avatar — it now also inspects
//     TokenVersion + IsPlatformBanned from that same row.
//
// Trade-off: revocation/ban land in up to userCacheTTL (30s) instead of
// instantly. This is the same trade-off accepted for IsPlatformBanned
// in the previous round (E3); TokenVersion now follows the same rule.
// For instant invalidation in critical paths, the mutation site can
// call AuthMiddleware.InvalidateUser to drop the cached row.
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
	return claims, nil
}

// MediaTokenTTL is the lifetime of a media-scoped token AND of the
// hichat_media cookie that carries it — the two must stay equal.
//
// The bug this replaces: the cookie had a 30-day Max-Age while its value was
// a ~15-minute access token. A tab left open (or reopened from history) past
// the access token's expiry kept sending a cookie the server had long since
// stopped honouring, so every <img src="/api/uploads/…"> 401'd and the client
// fell back to a generic file card. Aligning the two means the cookie is
// valid for exactly as long as the credential inside it.
//
// 7 days is the trade-off: long enough that an ordinary user never sees an
// image break between sessions, short enough that a leaked cookie ages out
// on its own. Refreshed on every login/register/refresh, so an active user's
// cookie is continuously renewed and never approaches the deadline.
const MediaTokenTTL = 7 * 24 * time.Hour

// ─── Password Reset ───

const resetCooldown = 90 * time.Second
const resetTokenExpiry = 20 * time.Minute

// usedRefreshEmergencyThreshold caps the in-memory used-refresh-token map.
// When exceeded, the next RefreshToken call performs inline expired-entry
// eviction so the hourly sweep can't fall behind during a refresh storm.
//
// Audit 2026-05-27 (P0-BC-02): chosen so a single instance can comfortably
// hold the active-window of a 1k-user deployment (each user refreshes
// every ~15min = ~67 entries/user across a 1h window; 10k cap is ~150
// users at peak). Multi-instance deploys should move this map to Redis —
// the threshold is a per-instance memory guard, not a global rate limit.
const usedRefreshEmergencyThreshold = 10_000

// GenerateMediaToken mints a narrowly-scoped JWT for the hichat_media cookie.
//
// Why a separate token rather than reusing the access token: a native <img>
// tag can't set an Authorization header, so attachment loads authenticate via
// a cookie — and a cookie is attached automatically to cross-site subresource
// requests (the cookie is deliberately SameSite=None so the Electron and
// Capacitor shells receive it; see setMediaCookie in handlers/auth.go). That
// makes it far more exposed than a header-borne token. When its value WAS the
// access token, anyone who obtained the cookie held a complete API credential
// they could replay as `Authorization: Bearer` or as a WebSocket `?token=`.
//
// The scope=media claim collapses that blast radius: AuthMiddleware.Require
// and the WS upgrade path reject any token carrying a scope, so a stolen
// media cookie can do nothing beyond re-fetching attachments its owner was
// already permitted to fetch — every /api/uploads response is still
// permission-checked per request.
//
// Signed with the same key and method as the access token so the existing
// ValidateAccessToken path verifies it with no extra plumbing.
//
// Production handlers mint GenerateSessionMediaToken with the authenticated
// logical session ID. Private downloads validate that durable session, so
// revocation also denies previously issued media cookies. This SID-less helper
// is retained for legacy interfaces/tests; session-aware production denies its
// use on private downloads rather than treating it as a revocation bypass.
func (s *authService) GenerateMediaToken(userID string) (string, error) {
	return s.GenerateSessionMediaToken(userID, "")
}

func (s *authService) GenerateSessionMediaToken(userID, sessionID string) (string, error) {
	now := time.Now()
	claims := &models.TokenClaims{
		SessionID: sessionID,
		UserID:    userID,
		Scope:     models.TokenScopeMedia,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(MediaTokenTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}

	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
	if err != nil {
		return "", fmt.Errorf("failed to sign media token: %w", err)
	}
	return signed, nil
}

// ─── Private Helpers ───

// signAccessToken mints the JWT access token for user. Pure signing, no DB
// I/O — shared by generateTokens (Login/RefreshToken) and Register, which
// can't use generateTokens because its session row must be created
// atomically with the user row, before the JWT is signed (see A4 in Register).
func (s *authService) signAccessToken(user *models.User, sessionIDs ...string) (string, error) {
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
	if len(sessionIDs) > 0 {
		accessClaims.SessionID = sessionIDs[0]
	}
	accessString, err := accessToken.SignedString(s.jwtSecret)
	if err != nil {
		return "", fmt.Errorf("failed to sign access token: %w", err)
	}
	return accessString, nil
}

func (s *authService) generateTokens(ctx context.Context, user *models.User) (*AuthTokens, error) {
	if s.authSessions != nil {
		return s.generateBoundTokens(ctx, user)
	}
	accessString, err := s.signAccessToken(user)
	if err != nil {
		return nil, err
	}

	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	refreshString := hex.EncodeToString(refreshBytes)

	session := &models.Session{
		UserID:       user.ID,
		RefreshToken: refreshString,
		ExpiresAt:    time.Now().Add(s.refreshExp),
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
