// Package services — cachingPermResolver: the caching decorator around the
// uncached channelPermService core.
//
// Why a decorator instead of a cache field on channelPermService itself
// (the previous shape): every code path that reads or writes the cache had
// to remember to build the key via permCacheKey and to call
// invalidateChannelCache after every mutation. That's a convention, not a
// guarantee — nothing stopped a future write path (or a second
// ChannelPermissionService implementation) from mutating overrides without
// invalidating, which leaves a revoked permission live in the cache for up
// to permCacheTTL (30s). Splitting the cache into its own type that owns
// 100% of the caching/invalidation logic, and making it the ONLY exported
// constructor's return value (NewChannelPermissionService in
// channel_permission_service.go), makes "some caller holds the uncached
// core and can silently skip invalidation" a compile-time impossibility:
// there is no exported way to obtain a *channelPermService that isn't
// wrapped in this type.
package services

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/cache"
)

const (
	permCacheTTL     = 30 * time.Second
	permCacheCleanup = 5 * time.Minute
)

// cachingPermResolver implements the full ChannelPermissionService
// interface. Resolve/ResolveBulk are cached; SetOverride/DeleteOverride
// delegate to inner and then invalidate the affected channel;
// InvalidateUser/InvalidateAll only make sense with a cache, so they live
// here and nowhere else; every other method is a pure pass-through to inner.
type cachingPermResolver struct {
	inner *channelPermService

	// permCache holds ResolveChannelPermissions results. Key: "userID:channelID"
	// (permCacheKey), built the same way on every read and write path here so
	// invalidateChannelCache/InvalidateUser's prefix/suffix matches can never
	// silently diverge from what Resolve/ResolveBulk wrote.
	permCache *cache.TTLCache[string, models.Permission]
	// Invalidations supersede DB reads already in flight. Never hold over IO.
	cacheMu       sync.Mutex
	cacheRevision uint64
}

// newCachingPermResolver wraps inner. Unexported: the only caller is
// NewChannelPermissionService.
func newCachingPermResolver(inner *channelPermService) *cachingPermResolver {
	return &cachingPermResolver{
		inner:     inner,
		permCache: cache.New[string, models.Permission](permCacheTTL, permCacheCleanup),
	}
}

// permCacheKey is the single source of truth for the permission cache key
// format. invalidateChannelCache and InvalidateUser match on the two halves
// of this string, so every code path that writes the cache MUST build its
// key here — a divergent key would be invisible to invalidation and let a
// revoked permission survive.
func permCacheKey(userID, channelID string) string {
	return userID + ":" + channelID
}

// ─── Pure pass-throughs — no caching involved ───

func (c *cachingPermResolver) GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error) {
	return c.inner.GetOverrides(ctx, serverID, channelID)
}

func (c *cachingPermResolver) BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error) {
	return c.inner.BuildVisibilityFilter(ctx, userID, serverID)
}

func (c *cachingPermResolver) ResolveUserChannelPermissions(ctx context.Context, userID, serverID string) (*UserChannelPermissions, error) {
	return c.inner.ResolveUserChannelPermissions(ctx, userID, serverID)
}

// ─── Mutations: delegate, then invalidate the affected channel ───

func (c *cachingPermResolver) SetOverride(ctx context.Context, serverID, channelID, roleID, actorID string, req *models.SetOverrideRequest) error {
	if err := c.inner.SetOverride(ctx, serverID, channelID, roleID, actorID, req); err != nil {
		return err
	}
	c.invalidateChannelCache(channelID)
	return nil
}

func (c *cachingPermResolver) DeleteOverride(ctx context.Context, serverID, channelID, roleID, actorID string) error {
	if err := c.inner.DeleteOverride(ctx, serverID, channelID, roleID, actorID); err != nil {
		return err
	}
	c.invalidateChannelCache(channelID)
	return nil
}

// ─── Cached reads ───

// ResolveChannelPermissions is the cached front door for the core's
// database-backed resolution. See channelPermService.ResolveChannelPermissions
// for the actual resolution logic.
func (c *cachingPermResolver) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	cacheKey := permCacheKey(userID, channelID)
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		c.cacheMu.Lock()
		revision := c.cacheRevision
		if cached, ok := c.permCache.Get(cacheKey); ok {
			c.cacheMu.Unlock()
			return cached, nil
		}
		c.cacheMu.Unlock()

		perm, err := c.inner.ResolveChannelPermissions(ctx, userID, channelID)
		if err != nil {
			return 0, err
		}

		c.cacheMu.Lock()
		if revision != c.cacheRevision {
			c.cacheMu.Unlock()
			continue
		}
		c.permCache.Set(cacheKey, perm)
		c.cacheMu.Unlock()
		return perm, nil
	}
	return 0, pkg.ErrForbidden
}

// ResolveChannelPermissionsFresh revalidates long-running authorized work.
// It remains on the cache decorator and honors invalidations during DB reads;
// no caller receives an uncached-core handle or a stale positive cache entry.
func (c *cachingPermResolver) ResolveChannelPermissionsFresh(ctx context.Context, userID, channelID string) (models.Permission, error) {
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		c.cacheMu.Lock()
		revision := c.cacheRevision
		c.cacheMu.Unlock()
		perm, err := c.inner.ResolveChannelPermissions(ctx, userID, channelID)
		if err != nil {
			return 0, err
		}
		c.cacheMu.Lock()
		changed := revision != c.cacheRevision
		c.cacheMu.Unlock()
		if !changed {
			return perm, nil
		}
	}
	return 0, pkg.ErrForbidden
}

// ResolveChannelPermissionsBulk probes the cache for every requested user
// and only asks the uncached core to resolve the misses, in one batched
// call — preserves the "at most 3 queries regardless of N" property the
// bulk path exists for (see channelPermService.ResolveChannelPermissionsBulk):
// filtering a broadcast to the online members of a server would otherwise
// cost 3N round trips every time the 30s cache expired.
func (c *cachingPermResolver) ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, superseded, err := c.resolveBulkAttempt(ctx, channelID, userIDs)
		if err != nil || !superseded {
			return result, err
		}
	}
	return nil, pkg.ErrForbidden
}

func (c *cachingPermResolver) resolveBulkAttempt(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, bool, error) {
	resolved := make(map[string]models.Permission, len(userIDs))
	if len(userIDs) == 0 {
		return resolved, false, nil
	}
	c.cacheMu.Lock()
	revision := c.cacheRevision

	// Probe the cache first; only the misses reach the core. Duplicates in
	// the caller's list (shouldn't happen, but the online-user list is built
	// from live connections) are collapsed here.
	misses := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if _, dup := seen[userID]; dup {
			continue
		}
		seen[userID] = struct{}{}

		if cached, ok := c.permCache.Get(permCacheKey(userID, channelID)); ok {
			resolved[userID] = cached
			continue
		}
		misses = append(misses, userID)
	}
	c.cacheMu.Unlock()
	if len(misses) == 0 {
		return resolved, false, nil
	}

	fresh, err := c.inner.ResolveChannelPermissionsBulk(ctx, channelID, misses)
	if err != nil {
		return nil, false, err
	}
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	if revision != c.cacheRevision {
		return nil, true, nil
	}
	for userID, perm := range fresh {
		c.permCache.Set(permCacheKey(userID, channelID), perm)
		resolved[userID] = perm
	}

	return resolved, false, nil
}

// ─── Invalidation — decorator-only; the uncached core has no cache to invalidate ───

// invalidateChannelCache clears all cached permissions for a given channel.
// Uses suffix match on "userID:channelID" keys since we can't know which
// users are affected.
func (c *cachingPermResolver) invalidateChannelCache(channelID string) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cacheRevision++
	suffix := ":" + channelID
	c.permCache.DeleteFunc(func(key string) bool {
		return strings.HasSuffix(key, suffix)
	})
}

// InvalidateUser clears every cached entry for one user.
//
// Mirrors invalidateChannelCache, just by the other half of the
// "userID:channelID" composite key. Called when a single user's role
// membership changes (assign/remove) or when they are kicked/banned
// from a server (defence — they should already be unable to call the
// API, but the cache entry would still leak through any half-finished
// request).
func (c *cachingPermResolver) InvalidateUser(userID string) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cacheRevision++
	prefix := userID + ":"
	c.permCache.DeleteFunc(func(key string) bool {
		return strings.HasPrefix(key, prefix)
	})
}

// InvalidateAll drops the entire cache.
//
// Used by role mutations (Update / Delete) where the change affects
// every member who holds the role across every channel. Enumerating
// those users would cost an extra "roles → users" query at every role
// edit; a full cache wipe lets the next request rebuild lazily and
// the system returns to steady state within permCacheTTL (30s).
func (c *cachingPermResolver) InvalidateAll() {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cacheRevision++
	c.permCache.DeleteFunc(func(string) bool { return true })
}

// Compile-time assertion: cachingPermResolver must satisfy the full
// interface, since it is the only value NewChannelPermissionService returns.
var _ ChannelPermissionService = (*cachingPermResolver)(nil)
