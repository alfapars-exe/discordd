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
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var channelPermLogger = logx.Component("service.channel_permission")

const (
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
	// actorID is the caller's own user id — N-03: SetOverride checks it can
	// never grant/deny a bit the actor doesn't itself hold on this channel,
	// and can never touch a role at or above the actor's own hierarchy
	// position.
	SetOverride(ctx context.Context, serverID, channelID, roleID, actorID string, req *models.SetOverrideRequest) error
	// DeleteOverride removes an override; actorID is checked against the
	// same role-hierarchy rule as SetOverride (N-03).
	DeleteOverride(ctx context.Context, serverID, channelID, roleID, actorID string) error
	// ResolveChannelPermissions computes effective permissions for a user in a channel.
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
	// ResolveChannelPermissionsBulk computes effective permissions for many
	// users in one channel using a constant number of queries.
	ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error)
	// BuildVisibilityFilter builds a per-user channel visibility filter for ViewChannel checks.
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
	// ResolveUserChannelPermissions computes, for one user across an entire
	// server, the effective Permission bitmask for every channel that has a
	// role override (bounded by override count, not total channel count),
	// plus the user's server-wide base permission for channels without one.
	// Same two-query shape as BuildVisibilityFilter (roleRepo.GetByUserIDAndServer
	// + permRepo.GetByRoles), generalised to the full bitmask instead of a
	// single PermViewChannel bit — SearchService uses it to apply
	// PermCanReadChannel (H-05).
	ResolveUserChannelPermissions(ctx context.Context, userID, serverID string) (*UserChannelPermissions, error)

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

// channelPermService is the uncached core: plain DB-backed permission
// resolution and override CRUD, no caching or invalidation. It does NOT
// implement the full ChannelPermissionService interface (InvalidateUser/
// InvalidateAll live only on the caching decorator, since they only mean
// something in the presence of a cache) — see newUncachedChannelPermService
// and channel_permission_cache.go for why that's structural, not just a
// convention.
type channelPermService struct {
	permRepo      repository.ChannelPermissionRepository
	roleRepo      repository.RoleRepository
	channelGetter ChannelGetter
	hub           ws.Broadcaster
}

// newUncachedChannelPermService constructs the core resolver, deliberately
// unexported: the ONLY way to obtain a ChannelPermissionService from this
// package is NewChannelPermissionService below, which always wraps this in
// cachingPermResolver. That makes "a permission revocation is invisible to
// invalidation because something got a direct handle on the uncached core"
// a compile-time impossibility rather than a code-review rule — see
// channel_permission_cache.go's doc comment for the incident this closes.
func newUncachedChannelPermService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	channelGetter ChannelGetter,
	hub ws.Broadcaster,
) *channelPermService {
	return &channelPermService{
		permRepo:      permRepo,
		roleRepo:      roleRepo,
		channelGetter: channelGetter,
		hub:           hub,
	}
}

// NewChannelPermissionService constructs the full service: the uncached
// core wrapped in the caching decorator. Every caller in this codebase gets
// caching this way — there is no exported path to the uncached core.
func NewChannelPermissionService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	channelGetter ChannelGetter,
	hub ws.Broadcaster,
) ChannelPermissionService {
	inner := newUncachedChannelPermService(permRepo, roleRepo, channelGetter, hub)
	return newCachingPermResolver(inner)
}

func (s *channelPermService) GetOverrides(ctx context.Context, serverID, channelID string) ([]models.ChannelPermissionOverride, error) {
	if _, _, err := s.validateOverrideScope(ctx, serverID, channelID, ""); err != nil {
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

// SetOverride writes the override and broadcasts it. Cache invalidation is
// NOT this method's job — the uncached core has no cache. cachingPermResolver
// invalidates the channel after this returns successfully (see its
// SetOverride wrapper).
func (s *channelPermService) SetOverride(ctx context.Context, serverID, channelID, roleID, actorID string, req *models.SetOverrideRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid override request: %w", err)
	}
	_, role, err := s.validateOverrideScope(ctx, serverID, channelID, roleID)
	if err != nil {
		return err
	}
	if role == nil {
		return fmt.Errorf("%w: role id is required", pkg.ErrBadRequest)
	}

	if err := s.checkChannelOverrideHierarchy(ctx, actorID, serverID, role); err != nil {
		return err
	}
	// N-03: check both Allow and Deny against the actor's own channel-scoped
	// permission (KULLANICI KARARI — a Deny the actor doesn't hold can lock a
	// higher-privileged role out of the channel just as effectively as an
	// Allow grants privilege it shouldn't).
	if err := s.checkOverrideEscalation(ctx, actorID, channelID, req.Allow|req.Deny); err != nil {
		return err
	}

	// allow=0, deny=0 -> no effect (same as inherit), delete
	if req.Allow == 0 && req.Deny == 0 {
		if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
			channelPermLogger.Error("failed to delete override (idempotent, non-fatal)", "channel_id", channelID, "role_id", roleID, "err", pkg.ErrText(err))
		}

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

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelPermissionUpdate,
		Data: override,
	})

	return nil
}

// DeleteOverride removes the override and broadcasts it. Same cache-
// invalidation split as SetOverride: cachingPermResolver invalidates after
// this returns successfully.
func (s *channelPermService) DeleteOverride(ctx context.Context, serverID, channelID, roleID, actorID string) error {
	_, role, err := s.validateOverrideScope(ctx, serverID, channelID, roleID)
	if err != nil {
		return err
	}
	if role == nil {
		return fmt.Errorf("%w: role id is required", pkg.ErrBadRequest)
	}
	// N-03: deleting an override can restore a higher effective permission
	// on the target role (e.g. removing a Deny), so it is gated by the same
	// hierarchy rule as SetOverride. No escalation (Allow/Deny bit) check
	// applies here — there is no requested bit, only a reversion to the
	// role's existing base permission, same as RoleService.Delete.
	if err := s.checkChannelOverrideHierarchy(ctx, actorID, serverID, role); err != nil {
		return err
	}

	if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
		return fmt.Errorf("failed to delete channel override: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpChannelPermissionDelete,
		Data: map[string]string{
			"channel_id": channelID,
			"role_id":    roleID,
		},
	})

	return nil
}

// validateOverrideScope confirms channelID belongs to serverID and, when
// roleID is non-empty, that roleID also belongs to serverID — returning the
// loaded role so callers (SetOverride, DeleteOverride) don't need a second
// roleRepo.GetByID just to read its Position for the hierarchy check.
// role is nil when roleID == "" (GetOverrides' use case).
func (s *channelPermService) validateOverrideScope(ctx context.Context, serverID, channelID, roleID string) (*models.Channel, *models.Role, error) {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get channel: %w", err)
	}
	if channel.ServerID != serverID {
		return nil, nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}

	var role *models.Role
	if roleID != "" {
		r, err := s.roleRepo.GetByID(ctx, roleID)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to get role: %w", err)
		}
		if r.ServerID != serverID {
			return nil, nil, fmt.Errorf("%w: role not found", pkg.ErrNotFound)
		}
		role = r
	}

	return channel, role, nil
}

// getActorMaxPosition returns the actor's highest role position in the
// server — mirrors RoleService.getActorMaxPosition (role_service.go); kept
// as a separate copy because the two services are independent types and
// this one is only ever called against *channelPermService's own roleRepo.
func (s *channelPermService) getActorMaxPosition(ctx context.Context, actorID, serverID string) (int, error) {
	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}
	return models.HighestPosition(actorRoles), nil
}

// checkChannelOverrideHierarchy enforces the same role-hierarchy rule
// RoleService applies to role edits (role_service.go Update/Delete): an
// actor may only touch overrides for a role strictly below their own
// highest role position. This applies unconditionally, including to actors
// who hold PermAdmin — only the owner role (HighestPosition == MaxInt32,
// see models.HighestPosition) outranks every other role.
func (s *channelPermService) checkChannelOverrideHierarchy(ctx context.Context, actorID, serverID string, role *models.Role) error {
	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID, serverID)
	if err != nil {
		return err
	}
	if role.Position >= actorMaxPos {
		return fmt.Errorf("%w: cannot modify a role with equal or higher position", pkg.ErrForbidden)
	}
	return nil
}

// checkOverrideEscalation enforces N-03: an actor may not place an override
// bit (Allow or Deny) on a channel that is not part of their own
// CHANNEL-scoped effective permission there. Channel-scoped, not the
// server-wide role OR the route's authServerPerm(PermManageChannels) gate
// already checked — an actor's own effective permission on this specific
// channel can itself already be reduced by an existing override.
func (s *channelPermService) checkOverrideEscalation(ctx context.Context, actorID, channelID string, requestedBits models.Permission) error {
	actorPerms, err := s.ResolveChannelPermissions(ctx, actorID, channelID)
	if err != nil {
		return fmt.Errorf("failed to resolve actor channel permissions: %w", err)
	}
	if actorPerms.Has(models.PermAdmin) {
		return nil
	}
	if escalated := requestedBits &^ actorPerms; escalated != 0 {
		return fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
	}
	return nil
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

// ResolveUserChannelPermissions computes, for one user across an entire
// server, the effective Permission bitmask for every channel that has a
// role override for that user's roles, plus the user's base (non-overridden)
// permission for every other channel. Same two-query shape as
// BuildVisibilityFilter (roleRepo.GetByUserIDAndServer + permRepo.GetByRoles)
// — reused here for the full bitmask instead of BuildVisibilityFilter's
// single PermViewChannel bit, so a caller checking a different bit pair
// (e.g. search's PermCanReadChannel — View AND Read) doesn't need a third,
// hand-rolled resolver. Unlike BuildVisibilityFilter, this calls the shared
// effectiveChannelPermission helper (see its doc comment) instead of
// inlining the formula, so it cannot silently disagree with
// ResolveChannelPermissions/ResolveChannelPermissionsBulk about the same
// channel.
func (s *channelPermService) ResolveUserChannelPermissions(ctx context.Context, userID, serverID string) (*UserChannelPermissions, error) {
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles for channel permission map: %w", err)
	}

	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, r := range roles {
		base |= r.Permissions
		roleIDs[i] = r.ID
	}

	if base.Has(models.PermAdmin) {
		return &UserChannelPermissions{IsAdmin: true, Base: models.PermAll}, nil
	}

	overrides, err := s.permRepo.GetByRoles(ctx, roleIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get role overrides for channel permission map: %w", err)
	}

	if len(overrides) == 0 {
		return &UserChannelPermissions{Base: base}, nil
	}

	// Group overrides by channel, OR allow/deny across all user roles — same
	// grouping BuildVisibilityFilter does, kept as its own small copy rather
	// than extracted into a shared helper: BuildVisibilityFilter is
	// exhaustively tested as-is and this task's scope is the two RBAC
	// findings, not a drive-by refactor of already-correct, already-tested
	// code.
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

	result := &UserChannelPermissions{
		Base:      base,
		Overrides: make(map[string]models.Permission, len(byChannel)),
	}
	for channelID, co := range byChannel {
		result.Overrides[channelID] = effectiveChannelPermission(base, co.allow, co.deny)
	}

	return result, nil
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

// ResolveChannelPermissions computes effective permissions for userID in
// channelID directly from the database — no caching here (see the
// channelPermService doc comment). Callers normally reach this indirectly
// through cachingPermResolver via NewChannelPermissionService; the core
// stays uncached in part so checkOverrideEscalation (called from
// SetOverride) always sees a fresh result for the actor's own permission,
// not a cache entry that could be stale mid-mutation.
func (s *channelPermService) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
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
		return models.PermAll, nil
	}

	overrides, err := s.permRepo.GetByChannelAndRoles(ctx, channelID, roleIDs)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel overrides for roles: %w", err)
	}

	if len(overrides) == 0 {
		return base, nil
	}

	// OR all override allow/deny bits across user's roles.
	var channelAllow, channelDeny models.Permission
	for _, o := range overrides {
		channelAllow |= o.Allow
		channelDeny |= o.Deny
	}

	return effectiveChannelPermission(base, channelAllow, channelDeny), nil
}

// ResolveChannelPermissionsBulk resolves effective permissions for every
// user in userIDs directly from the database — no caching (see
// ResolveChannelPermissions's doc comment above). cachingPermResolver is the
// one that turns this into "misses only" for its cache-miss list; this
// method just needs to resolve whatever list it's given in a bounded number
// of queries:
//
//  1. one channelGetter.GetByID for the server id
//  2. one roleRepo.GetRolesForUsers for userIDs
//  3. one permRepo.GetByChannel, filtered per user's role set in memory
//
// regardless of len(userIDs). Users holding no roles resolve to 0.
func (s *channelPermService) ResolveChannelPermissionsBulk(ctx context.Context, channelID string, userIDs []string) (map[string]models.Permission, error) {
	resolved := make(map[string]models.Permission, len(userIDs))
	if len(userIDs) == 0 {
		return resolved, nil
	}

	// Dedup — the caller's list (built from live connections) shouldn't
	// contain repeats, but a duplicate here would waste a
	// roleRepo.GetRolesForUsers slot for nothing.
	unique := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if _, dup := seen[userID]; dup {
			continue
		}
		seen[userID] = struct{}{}
		unique = append(unique, userID)
	}

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel for bulk permission resolution: %w", err)
	}

	rolesByUser, err := s.roleRepo.GetRolesForUsers(ctx, channel.ServerID, unique)
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

	for _, userID := range unique {
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

		resolved[userID] = effectiveChannelPermission(base, channelAllow, channelDeny)
	}

	return resolved, nil
}
