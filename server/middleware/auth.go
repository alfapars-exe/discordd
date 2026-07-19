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

// AuthMiddleware validates JWT tokens on incoming requests.
type AuthMiddleware struct {
	authService services.AuthService
	userRepo    repository.UserRepository

	// userCache memoizes GetByID lookups keyed by user id. The cache is
	// shared across all middleware instances (only one is constructed in
	// main.go) and read on every authenticated request. Invalidate on
	// password change / user delete by calling InvalidateUser.
	userCache *cache.TTLCache[string, *models.User]
}

func NewAuthMiddleware(authService services.AuthService, userRepo repository.UserRepository) *AuthMiddleware {
	return &AuthMiddleware{
		authService: authService,
		userRepo:    userRepo,
		userCache:   cache.New[string, *models.User](userCacheTTL, time.Minute),
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

		claims, err := m.authService.ValidateAccessToken(tokenString)
		if err != nil {
			pkg.Error(w, err)
			return
		}

		// Scope gate — deny by default.
		//
		// Only unscoped tokens (full API access tokens) may authenticate an
		// API route. The one scoped token the server issues today is the
		// media token in the hichat_media cookie, which authenticates
		// GET /api/uploads/* and nothing else.
		//
		// This is the point of the scoped-token change. Because that cookie
		// is SameSite=None and rides along on cross-site subresource loads,
		// it is materially easier to leak than a header-borne token; before
		// scoping, its value was the access token itself, so a leak handed
		// the holder the entire API. Rejecting every non-empty scope here
		// means such a leak reaches attachments only.
		//
		// Rejecting UNKNOWN scopes (not just "media") is deliberate: a token
		// minted by a future, more privileged-looking scope must fail closed
		// against an older binary that has no idea what it means.
		if claims.Scope != "" {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "token scope not valid for this endpoint")
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
