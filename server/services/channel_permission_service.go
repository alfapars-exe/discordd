// Package services — ChannelPermissionService: per-channel permission overrides.
//
// Discord-style per-channel role overrides with allow/deny bits.
//
// Permission resolution (Discord algorithm):
//
//	base = OR of all role permissions
//	channelAllow = OR of override allows for user's roles
//	channelDeny  = OR of override denies for user's roles
//	effective    = (base & ~channelDeny) | channelAllow
//
// Admin bypasses all overrides.
package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/cache"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const (
	permCacheTTL     = 30 * time.Second
	permCacheCleanup = 5 * time.Minute

	// broadcastResolveTimeout bounds permission resolution that runs after the
	// originating request has already committed — WS fan-out happens in
	// goroutines with no request context to inherit, so without a bound a
	// wedged connection would pin the goroutine forever. 5s sits just above
	// the DB busy_timeout (5000ms) so a legitimate lock wait is not cancelled
	// a moment before it would have succeeded.
	broadcastResolveTimeout = 5 * time.Second
)

// BroadcastContext returns a bounded background context for post-commit
// broadcast fan-out work (permission resolution for the recipient list).
// Exported so package main's WS callbacks share the same bound as the services.
// Callers must call the returned cancel func.
func BroadcastContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), broadcastResolveTimeout)
}

// ChannelPermResolver is an ISP interface for permission resolution only.
// Used by MessageService and VoiceService to avoid depending on the full ChannelPermissionService.
type ChannelPermResolver interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
	// ResolveChannelPermissionsBulk resolves many users at once in a constant
	// number of queries. Use it for broadcast fan-out; the single-user method
	// is for request-scoped checks.
	ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error)
}

// ChannelPermissionService manages per-channel permission overrides.
type ChannelPermissionService interface {
	GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error)
	// SetOverride creates or updates an override. If allow=0 and deny=0, deletes it (revert to inherit).
	SetOverride(ctx context.Context, serverID, channelID, roleID string, req *models.SetOverrideRequest) error
	DeleteOverride(ctx context.Context, serverID, channelID, roleID string) error
	// ResolveChannelPermissions computes effective permissions for a user in a channel.
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
	// ResolveChannelPermissionsBulk computes effective permissions for many
	// users in one channel using a constant number of queries.
	ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error)
	// BuildVisibilityFilter builds a per-user channel visibility filter for ViewChannel checks.
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)

	// InvalidateUser drops every cached permission entry for one user.
	// Wire into member kick/ban/role-add/role-remove so a permission
	// revocation lands within ~1s instead of after permCacheTTL (30s).
	InvalidateUser(userID string)
	// InvalidateAll drops the entire cache. Used by RoleService when a
	// role's permission bits change — that affects every member with
	// the role across every channel, and enumerating them costs more
	// than a full cache rebuild over the TTL window.
	InvalidateAll()
}

// PermissionInvalidator is the cache-invalidation slice of
// ChannelPermissionService, exposed as its own interface so
// RoleService / MemberService can depend on the smallest possible
// surface (ISP) and tests can supply trivial stubs.
type PermissionInvalidator interface {
	InvalidateUser(userID string)
	InvalidateAll()
}

type channelPermService struct {
	permRepo      repository.ChannelPermissionRepository
	roleRepo      repository.RoleRepository
	channelGetter ChannelGetter
	hub           ws.Broadcaster

	// Cache for ResolveChannelPermissions results. Key: "userID:channelID".
	// Invalidated per-channel when overrides change.
	permCache *cache.TTLCache[string, models.Permission]
}

func NewChannelPermissionService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	channelGetter ChannelGetter,
	hub ws.Broadcaster,
) ChannelPermissionService {
	return &channelPermService{
		permRepo:      permRepo,
		roleRepo:      roleRepo,
		channelGetter: channelGetter,
		hub:           hub,
		permCache:     cache.New[string, models.Permission](permCacheTTL, permCacheCleanup),
	}
}

func (s *channelPermService) GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error) {
	if _, err := s.validateOverrideScope(ctx, serverID, channelID, ""); err != nil {
		return nil, err
	}

	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel overrides: %w", err)
	}

	if overrides == nil {
		overrides = []models.ChannelPermissionOverride{}
	}

	return overrides, nil
}

func (s *channelPermService) SetOverride(ctx context.Context, serverID, channelID, roleID string, req *models.SetOverrideRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid override request: %w", err)
	}
	if _, err := s.validateOverrideScope(ctx, serverID, channelID, roleID); err != nil {
		return err
	}

	// allow=0, deny=0 -> no effect (same as inherit), delete
	if req.Allow == 0 && req.Deny == 0 {
		if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
			log.Printf("[channel-perm] failed to delete override (idempotent, non-fatal) channel=%s role=%s: %v", channelID, roleID, err)
		}

		s.invalidateChannelCache(channelID)

		s.hub.BroadcastToServer(serverID, ws.Event{
			Op: ws.OpChannelPermissionDelete,
			Data: map[string]string{
				"channel_id": channelID,
				"role_id":    roleID,
			},
		})

		return nil
	}

	override := &models.ChannelPermissionOverride{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     req.Allow,
		Deny:      req.Deny,
	}

	if err := s.permRepo.Set(ctx, override); err != nil {
		return fmt.Errorf("failed to set channel override: %w", err)
	}

	s.invalidateChannelCache(channelID)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelPermissionUpdate,
		Data: override,
	})

	return nil
}

func (s *channelPermService) DeleteOverride(ctx context.Context, serverID, channelID, roleID string) error {
	if _, err := s.validateOverrideScope(ctx, serverID, channelID, roleID); err != nil {
		return err
	}
	if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
		return fmt.Errorf("failed to delete channel override: %w", err)
	}

	s.invalidateChannelCache(channelID)

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpChannelPermissionDelete,
		Data: map[string]string{
			"channel_id": channelID,
			"role_id":    roleID,
		},
	})

	return nil
}

func (s *channelPermService) validateOverrideScope(ctx context.Context, serverID, channelID, roleID string) (*models.Channel, error) {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel: %w", err)
	}
	if channel.ServerID != serverID {
		return nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}

	if roleID != "" {
		role, err := s.roleRepo.GetByID(ctx, roleID)
		if err != nil {
			return nil, fmt.Errorf("failed to get role: %w", err)
		}
		if role.ServerID != serverID {
			return nil, fmt.Errorf("%w: role not found", pkg.ErrNotFound)
		}
	}

	return channel, nil
}

// BuildVisibilityFilter builds a per-user channel visibility filter.
// Returns IsAdmin=true if user has Admin permission (sees all channels).
func (s *channelPermService) BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error) {
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles for visibility filter: %w", err)
	}

	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, r := range roles {
		base |= r.Permissions
		roleIDs[i] = r.ID
	}

	if base.Has(models.PermAdmin) {
		return &ChannelVisibilityFilter{IsAdmin: true}, nil
	}

	hasBaseView := base.Has(models.PermViewChannel)

	overrides, err := s.permRepo.GetByRoles(ctx, roleIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get role overrides for visibility filter: %w", err)
	}

	if len(overrides) == 0 {
		return &ChannelVisibilityFilter{
			HasBaseView:     hasBaseView,
			HiddenChannels:  make(map[string]bool),
			GrantedChannels: make(map[string]bool),
		}, nil
	}

	// Group overrides by channel, OR allow/deny across all user roles
	type channelOverride struct {
		allow models.Permission
		deny  models.Permission
	}
	byChannel := make(map[string]*channelOverride)
	for _, o := range overrides {
		co, ok := byChannel[o.ChannelID]
		if !ok {
			co = &channelOverride{}
			byChannel[o.ChannelID] = co
		}
		co.allow |= o.Allow
		co.deny |= o.Deny
	}

	hidden := make(map[string]bool)
	granted := make(map[string]bool)

	for channelID, co := range byChannel {
		effective := (base & ^co.deny) | co.allow
		hasView := effective.Has(models.PermViewChannel)

		if hasBaseView && !hasView {
			hidden[channelID] = true
		} else if !hasBaseView && hasView {
			granted[channelID] = true
		}
	}

	return &ChannelVisibilityFilter{
		HasBaseView:     hasBaseView,
		HiddenChannels:  hidden,
		GrantedChannels: granted,
	}, nil
}

// permCacheKey is the single source of truth for the permission cache key
// format. invalidateChannelCache and InvalidateUser match on the two halves of
// this string, so every code path that writes the cache MUST build its key
// here — a divergent key would be invisible to invalidation and let a revoked
// permission survive.
func permCacheKey(userID, channelID string) string {
	return userID + ":" + channelID
}

// effectiveChannelPermission applies the Discord resolution formula shared by
// the single-user and bulk paths.
//
// base is the OR of the user's role permission bits; allow/deny are the OR of
// the channel overrides attached to those roles. Admin short-circuits to
// PermAll before any override is considered. Otherwise allow wins over deny
// for the same bit, because it is OR'd back in after the deny mask is applied.
//
// Both paths call this — do not inline the formula anywhere else, or the fast
// path can silently disagree with the slow one about who may read a channel.
func effectiveChannelPermission(base, allow, deny models.Permission) models.Permission {
	if base.Has(models.PermAdmin) {
		return models.PermAll
	}
	return (base &^ deny) | allow
}

func (s *channelPermService) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	cacheKey := permCacheKey(userID, channelID)
	if cached, ok := s.permCache.Get(cacheKey); ok {
		return cached, nil
	}

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel for permission resolution: %w", err)
	}

	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, channel.ServerID)
	if err != nil {
		return 0, fmt.Errorf("failed to get user roles: %w", err)
	}

	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, role := range roles {
		base |= role.Permissions
		roleIDs[i] = role.ID
	}

	// Admin bypasses all overrides
	if base.Has(models.PermAdmin) {
		s.permCache.Set(cacheKey, models.PermAll)
		return models.PermAll, nil
	}

	overrides, err := s.permRepo.GetByChannelAndRoles(ctx, channelID, roleIDs)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel overrides for roles: %w", err)
	}

	if len(overrides) == 0 {
		s.permCache.Set(cacheKey, base)
		return base, nil
	}

	// OR all override allow/deny bits across user's roles.
	var channelAllow, channelDeny models.Permission
	for _, o := range overrides {
		channelAllow |= o.Allow
		channelDeny |= o.Deny
	}

	effective := effectiveChannelPermission(base, channelAllow, channelDeny)

	s.permCache.Set(cacheKey, effective)

	return effective, nil
}

// ResolveChannelPermissionsBulk resolves effective permissions for many users
// in one channel using a bounded number of queries.
//
// The single-user path costs 3 queries on a cache miss (channel + roles +
// overrides), so filtering a broadcast to the online members of a server used
// to cost 3N round trips — ~300 for a 100-member server every time the 30s
// cache expired, each one a network hop against remote Turso over a
// 4-connection pool. This collapses that to at most 3 regardless of N:
//
//  1. one channelGetter.GetByID for the server id
//  2. one roleRepo.GetRolesForUsers for the cache misses
//  3. one permRepo.GetByChannel, filtered per user's role set in memory
//
// Cache keys, TTL and the resolution formula are shared with the single-user
// path, so existing invalidation hooks cover bulk-written entries unchanged
// and the two paths cannot disagree. Users holding no roles resolve to 0,
// matching the single-user behaviour.
func (s *channelPermService) ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
	resolved := make(map[string]models.Permission, len(userIDs))
	if len(userIDs) == 0 {
		return resolved, nil
	}

	// Probe the cache first; only the misses reach the database. Duplicates in
	// the caller's list (shouldn't happen, but the online-user list is built
	// from connections) are collapsed here.
	misses := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if _, dup := seen[userID]; dup {
			continue
		}
		seen[userID] = struct{}{}

		if cached, ok := s.permCache.Get(permCacheKey(userID, channelID)); ok {
			resolved[userID] = cached
			continue
		}
		misses = append(misses, userID)
	}
	if len(misses) == 0 {
		return resolved, nil
	}

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel for bulk permission resolution: %w", err)
	}

	rolesByUser, err := s.roleRepo.GetRolesForUsers(ctx, channel.ServerID, misses)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles for users: %w", err)
	}

	// Every override on the channel, fetched once. The single-user path asks
	// the database to filter by role id; here we fetch the channel's full
	// (small — one row per role with an override) set and filter in memory,
	// which is what turns N queries into one.
	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel overrides for bulk resolution: %w", err)
	}

	type overrideBits struct{ allow, deny models.Permission }
	byRole := make(map[string]overrideBits, len(overrides))
	for _, o := range overrides {
		bits := byRole[o.RoleID]
		bits.allow |= o.Allow
		bits.deny |= o.Deny
		byRole[o.RoleID] = bits
	}

	for _, userID := range misses {
		roles := rolesByUser[userID]

		var base, channelAllow, channelDeny models.Permission
		for _, role := range roles {
			base |= role.Permissions
		}
		// Admin ignores overrides entirely, so skip the lookup for them —
		// effectiveChannelPermission would discard the bits anyway.
		if !base.Has(models.PermAdmin) {
			for _, role := range roles {
				bits, ok := byRole[role.ID]
				if !ok {
					continue
				}
				channelAllow |= bits.allow
				channelDeny |= bits.deny
			}
		}

		effective := effectiveChannelPermission(base, channelAllow, channelDeny)
		s.permCache.Set(permCacheKey(userID, channelID), effective)
		resolved[userID] = effective
	}

	return resolved, nil
}

// invalidateChannelCache clears all cached permissions for a given channel.
// Uses suffix match on "userID:channelID" keys since we can't know which users are affected.
func (s *channelPermService) invalidateChannelCache(channelID string) {
	suffix := ":" + channelID
	s.permCache.DeleteFunc(func(key string) bool {
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
func (s *channelPermService) InvalidateUser(userID string) {
	prefix := userID + ":"
	s.permCache.DeleteFunc(func(key string) bool {
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
func (s *channelPermService) InvalidateAll() {
	s.permCache.DeleteFunc(func(string) bool { return true })
}
