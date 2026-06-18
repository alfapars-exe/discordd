package middleware

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/cache"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

// userCacheTTL controls how long an authenticated user record is reused
// without re-reading the users row. 30 seconds is short enough for a
// password change or account deletion to take effect promptly (worst case
// 30s of stale access), and long enough to absorb the per-request lookup
// load — a single browser tab fires dozens of API calls per minute, and
// without caching every one hit the users row plus the JWT decode.
const userCacheTTL = 30 * time.Second

// BotTokenValidator resolves a bot bearer token to its bot user id.
// Separate interface to avoid importing services into middleware wholesale.
type BotTokenValidator interface {
	ValidateBotToken(ctx context.Context, token string) (string, error)
}

// AuthMiddleware validates JWT tokens on incoming requests.
type AuthMiddleware struct {
	authService  services.AuthService
	userRepo     repository.UserRepository
	botValidator BotTokenValidator

	// userCache memoizes GetByID lookups keyed by user id. The cache is
	// shared across all middleware instances (only one is constructed in
	// main.go) and read on every authenticated request. Invalidate on
	// password change / user delete by calling InvalidateUser.
	userCache *cache.TTLCache[string, *models.User]
}

func NewAuthMiddleware(authService services.AuthService, userRepo repository.UserRepository, botValidator BotTokenValidator) *AuthMiddleware {
	return &AuthMiddleware{
		authService:  authService,
		userRepo:     userRepo,
		botValidator: botValidator,
		userCache:    cache.New[string, *models.User](userCacheTTL, time.Minute),
	}
}

// InvalidateUser drops the cached user row. Wire into the user/profile
// update path and into ChangePassword so a session that just changed its
// password doesn't keep an old user view for up to userCacheTTL.
func (m *AuthMiddleware) InvalidateUser(userID string) {
	m.userCache.Delete(userID)
}

// Require enforces a valid JWT token. Returns 401 if missing or invalid.
func (m *AuthMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "authorization header required")
			return
		}

		if !strings.HasPrefix(authHeader, "Bearer ") {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "invalid authorization format, use: Bearer <token>")
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		// Bot path: bot tokens are prefixed and resolve to a bot users row.
		// They bypass JWT/token_version logic — revocation is enforced at the
		// bot_tokens row (ValidateBotToken returns an error once revoked).
		if m.botValidator != nil && strings.HasPrefix(tokenString, models.BotTokenPrefix) {
			botUserID, err := m.botValidator.ValidateBotToken(r.Context(), tokenString)
			if err != nil {
				pkg.ErrorWithMessage(w, http.StatusUnauthorized, "invalid bot token")
				return
			}
			botUser, err := m.userRepo.GetByID(r.Context(), botUserID)
			if err != nil {
				pkg.ErrorWithMessage(w, http.StatusUnauthorized, "bot user not found")
				return
			}
			// Parity with the human + WS paths: a platform-banned bot (admins
			// can ban a bot user row directly) must not authenticate. The
			// !IsBot check is defense-in-depth — a token row should only ever
			// resolve to a bot user.
			if !botUser.IsBot || botUser.IsPlatformBanned {
				pkg.ErrorWithMessage(w, http.StatusUnauthorized, "account suspended")
				return
			}
			botUser.PasswordHash = ""
			ctx := context.WithValue(r.Context(), handlers.UserContextKey, botUser)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		claims, err := m.authService.ValidateAccessToken(tokenString)
		if err != nil {
			pkg.Error(w, err)
			return
		}

		// Cache hit: skip the users-row read entirely. Cache miss: read,
		// scrub the password hash, store the scrubbed copy. Storing the
		// scrubbed pointer means subsequent hits can't leak the hash
		// even if a future code path forgets to clear it.
		user, ok := m.userCache.Get(claims.UserID)
		if !ok {
			loaded, lookupErr := m.userRepo.GetByID(r.Context(), claims.UserID)
			if lookupErr != nil {
				pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found")
				return
			}
			loaded.PasswordHash = ""
			m.userCache.Set(claims.UserID, loaded)
			user = loaded
		}

		// Revocation + ban gate against the cached user row.
		//
		// Moved here from AuthService.ValidateAccessToken so a warm cache
		// can satisfy the entire authenticated request with zero DB reads
		// (previously the validator always hit users by ID before this
		// middleware ran, so the cache hit only saved the SECOND read).
		//
		// Trade-off: revocation / ban can be up to userCacheTTL stale
		// (30s). This is the same trade-off already accepted for
		// IsPlatformBanned in the previous turn — TokenVersion now
		// follows the same rule. For instant invalidation (rare),
		// password change / logout-from-all-devices / ban paths should
		// call AuthMiddleware.InvalidateUser to drop the cached row
		// (see authService.ChangePassword wiring for the existing path).
		if claims.TokenVersion < user.TokenVersion {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "token revoked (logged out from all devices)")
			return
		}
		if user.IsPlatformBanned {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "account suspended")
			return
		}

		ctx := context.WithValue(r.Context(), handlers.UserContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
