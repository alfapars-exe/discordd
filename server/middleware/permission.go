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
)

// permCacheTTL caps how long an effective-permissions read is reused.
// Short enough that role changes take effect quickly; long enough to absorb
// the per-request load from a chatty client. The cache is per
// userID+serverID, so a role edit on server A doesn't poison server B's
// permission reads for the same user.
const permCacheTTL = 30 * time.Second

// PermissionMiddleware checks user permissions within a server context.
// Runs after AuthMiddleware + ServerMembershipMiddleware.
type PermissionMiddleware struct {
	roleRepo repository.RoleRepository

	// permCache memoizes the (userID, serverID) -> effective Permission
	// computation that previously hit the DB on every request.
	permCache *cache.TTLCache[string, models.Permission]
}

func NewPermissionMiddleware(roleRepo repository.RoleRepository) *PermissionMiddleware {
	return &PermissionMiddleware{
		roleRepo:  roleRepo,
		permCache: cache.New[string, models.Permission](permCacheTTL, time.Minute),
	}
}

func permCacheKey(userID, serverID string) string {
	return userID + ":" + serverID
}

// InvalidateUserPermissions drops every cached entry for this user across
// all servers. Call this from the role-assignment / role-permission-edit /
// member-removal paths so the next request sees fresh permissions instead
// of waiting up to permCacheTTL for the entry to expire.
func (m *PermissionMiddleware) InvalidateUserPermissions(userID string) {
	prefix := userID + ":"
	m.permCache.DeleteFunc(func(key string) bool {
		return strings.HasPrefix(key, prefix)
	})
}

// InvalidateServerPermissions drops every cached entry for every member of
// a server. Used when a role's permission mask is edited (which affects
// every member who has that role).
func (m *PermissionMiddleware) InvalidateServerPermissions(serverID string) {
	suffix := ":" + serverID
	m.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}

// resolveEffectivePerms returns the cached permission mask, falling back to
// a DB lookup on miss.
func (m *PermissionMiddleware) resolveEffectivePerms(r *http.Request, userID, serverID string) (models.Permission, error) {
	key := permCacheKey(userID, serverID)
	if perms, ok := m.permCache.Get(key); ok {
		return perms, nil
	}

	roles, err := m.roleRepo.GetByUserIDAndServer(r.Context(), userID, serverID)
	if err != nil {
		return 0, err
	}
	var effective models.Permission
	for _, role := range roles {
		effective |= role.Permissions
	}
	m.permCache.Set(key, effective)
	return effective, nil
}

// Load puts effective permissions into context without requiring any specific one.
// Used when the handler needs to make its own authorization decision
// (e.g. "owner OR has ManageMessages").
func (m *PermissionMiddleware) Load(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		serverID, ok := r.Context().Value(handlers.ServerIDContextKey).(string)
		if !ok || serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required for permission check")
			return
		}

		effectivePerms, err := m.resolveEffectivePerms(r, user.ID, serverID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get user roles")
			return
		}

		ctx := context.WithValue(r.Context(), handlers.PermissionsContextKey, effectivePerms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Require returns a middleware that enforces a specific permission.
func (m *PermissionMiddleware) Require(perm models.Permission, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		serverID, ok := r.Context().Value(handlers.ServerIDContextKey).(string)
		if !ok || serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required for permission check")
			return
		}

		effectivePerms, err := m.resolveEffectivePerms(r, user.ID, serverID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get user roles")
			return
		}

		if !effectivePerms.Has(perm) {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "insufficient permissions")
			return
		}

		ctx := context.WithValue(r.Context(), handlers.PermissionsContextKey, effectivePerms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
