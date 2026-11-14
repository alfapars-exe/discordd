package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
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

	*PermissionCache
}

func NewPermissionMiddleware(roleRepo repository.RoleRepository, owner *PermissionCache) *PermissionMiddleware {
	if owner == nil {
		owner = NewPermissionCache()
	}
	return &PermissionMiddleware{
		roleRepo:        roleRepo,
		PermissionCache: owner,
	}
}

func permCacheKey(userID, serverID string) string {
	return userID + ":" + serverID
}

// resolveEffectivePerms returns the cached permission mask, falling back to
// a DB lookup on miss.
func (m *PermissionMiddleware) resolveEffectivePerms(r *http.Request, userID, serverID string) (models.Permission, error) {
	key := permCacheKey(userID, serverID)
	for attempt := 0; attempt < 3; attempt++ {
		if err := r.Context().Err(); err != nil {
			return 0, err
		}
		m.cacheMu.Lock()
		revision := m.cacheRevision
		if perms, ok := m.permCache.Get(key); ok {
			m.cacheMu.Unlock()
			return perms, nil
		}
		m.cacheMu.Unlock()

		roles, err := m.roleRepo.GetByUserIDAndServer(r.Context(), userID, serverID)
		if err != nil {
			return 0, err
		}
		var effective models.Permission
		for _, role := range roles {
			effective |= role.Permissions
		}
		m.cacheMu.Lock()
		if m.cacheRevision != revision {
			m.cacheMu.Unlock()
			continue // A committed role change supersedes this in-flight lookup.
		}
		m.permCache.Set(key, effective)
		m.cacheMu.Unlock()
		return effective, nil
	}
	// Sustained mutation must not turn into an unbounded retry loop or a stale grant.
	return 0, pkg.ErrForbidden
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

// Stop retires the middleware cache worker while preserving draining access.
func (m *PermissionMiddleware) Stop() { m.Close() }
