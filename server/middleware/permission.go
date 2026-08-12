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
//
// Audit 2026-05-27 (P0-BC-04): tightened from 30s → 5s. The previous 30s
// window meant a revoked admin role could still authorize privileged
// actions for up to 30s after revocation — unacceptable for an incident-
// response scenario (compromised account being demoted).
//
// Trade-off: cache miss rate is ~6x higher (every 5s vs every 30s), so
// burst-heavy clients (rapid channel switching, role inspector tools) hit
// the role repository more often. Mitigations:
//  1. Event-driven invalidation: this cache is wired as one of the fan-out
//     targets of a services.PermissionInvalidator composite (see
//     services.NewMultiInvalidator, wired in main.go after initRoutes).
//     Member-write paths (kick/ban/role-reassign) call InvalidateUser;
//     role-permission-mask edits call InvalidateAll — so the cache is
//     correct between TTL boundaries already instead of relying on TTL
//     expiry alone.
//  2. roleRepo.GetByUserIDAndServer is itself indexed (PK lookup +
//     role_members JOIN) — sub-millisecond at typical scale.
//
// If DB load becomes a problem under specific access patterns, prefer
// adding an L2 cache (Redis) rather than relaxing the TTL.
const permCacheTTL = 5 * time.Second

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
// all servers. Wired via InvalidateUser (below) into the
// services.PermissionInvalidator composite that member-write paths
// (kick/ban/role-reassign) call, so the next request sees fresh
// permissions instead of waiting up to permCacheTTL for the entry to
// expire.
func (m *PermissionMiddleware) InvalidateUserPermissions(userID string) {
	prefix := userID + ":"
	m.permCache.DeleteFunc(func(key string) bool {
		return strings.HasPrefix(key, prefix)
	})
}

// InvalidateServerPermissions drops every cached entry for every member of
// a server. Currently unused by any wired call site (role-permission-mask
// edits use InvalidateAll instead, since a role's server isn't known from
// the composite's ISP-narrowed interface) — kept for symmetry with
// channelPermService and as the natural target if a server-scoped
// invalidation path is added later.
func (m *PermissionMiddleware) InvalidateServerPermissions(serverID string) {
	suffix := ":" + serverID
	m.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}

// InvalidateUser satisfies services.PermissionInvalidator so this
// middleware can be wired as a fan-out target alongside
// channelPermService. Delegates to InvalidateUserPermissions.
func (m *PermissionMiddleware) InvalidateUser(userID string) {
	m.InvalidateUserPermissions(userID)
}

// InvalidateAll drops the entire cache. Used when a role's permission mask
// changes — that affects every member holding the role, and this cache
// only keys on (userID, serverID), not role, so a full wipe is the correct
// (and only practical) response. Mirrors channelPermService.InvalidateAll.
func (m *PermissionMiddleware) InvalidateAll() {
	m.permCache.Clear()
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
			pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to get user roles", err)
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
			pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to get user roles", err)
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
