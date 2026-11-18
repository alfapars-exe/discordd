package middleware

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/cache"
	"strings"
	"sync"
	"time"
)

// PermissionCache owns grant publication and invalidation under one revision
// boundary, independently of the request middleware that loads repository data.
type PermissionCache struct {
	// permCache memoizes the (userID, serverID) -> effective Permission
	// computation that previously hit the DB on every request.
	permCache *cache.TTLCache[string, models.Permission]
	// Serializes revision checks/cache publication with invalidation, never DB IO.
	cacheMu       sync.Mutex
	cacheRevision uint64
}

func NewPermissionCache() *PermissionCache {
	return &PermissionCache{permCache: cache.New[string, models.Permission](permCacheTTL, time.Minute)}
}
func (m *PermissionCache) Close() { m.permCache.Close() }

// InvalidateUserPermissions drops every cached entry for this user across
// all servers. Wired via InvalidateUser (below) into the
// services.PermissionInvalidator composite that member-write paths
// (kick/ban/role-reassign) call, so the next request sees fresh
// permissions instead of waiting up to permCacheTTL for the entry to
// expire.
func (m *PermissionCache) InvalidateUserPermissions(userID string) {
	m.cacheMu.Lock()
	defer m.cacheMu.Unlock()
	m.cacheRevision++
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
func (m *PermissionCache) InvalidateServerPermissions(serverID string) {
	m.cacheMu.Lock()
	defer m.cacheMu.Unlock()
	m.cacheRevision++
	suffix := ":" + serverID
	m.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}

// InvalidateUser satisfies services.PermissionInvalidator so this
// middleware can be wired as a fan-out target alongside
// channelPermService. Delegates to InvalidateUserPermissions.
func (m *PermissionCache) InvalidateUser(userID string) {
	m.InvalidateUserPermissions(userID)
}

// InvalidateAll drops the entire cache. Used when a role's permission mask
// changes — that affects every member holding the role, and this cache
// only keys on (userID, serverID), not role, so a full wipe is the correct
// (and only practical) response. Mirrors channelPermService.InvalidateAll.
func (m *PermissionCache) InvalidateAll() {
	m.cacheMu.Lock()
	defer m.cacheMu.Unlock()
	m.cacheRevision++
	m.permCache.Clear()
}
