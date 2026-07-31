package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

var searchLogger = logx.Component("service.search")

// maxSearchChannelFilter caps how many channel IDs SearchService passes to
// the repository as an allow-list for one query. Modern SQLite (both
// modernc.org/sqlite and libsql/Turso are >= 3.32) defaults to a
// 32766-bound-parameter ceiling, so this cap is not driven by hitting that
// limit — it exists to bound query cost for a server with an implausibly
// large channel count. Truncation is deliberately fail-closed-safe, never
// fail-open: dropped IDs are simply left out of the *allowed* list, so a
// truncated user can under-search channels they are actually allowed to
// read, but can never search a channel they are not permitted to read.
const maxSearchChannelFilter = 500

// ChannelLister enumerates a server's channels. SearchService needs the full
// channel list to turn ChannelPermissionMapper's per-channel override map
// (bounded by override count) into a concrete allow-list of channel IDs for
// the FTS query — the same combination ChannelService.GetAllGrouped already
// makes of channelRepo.GetAllByServer + BuildVisibilityFilter.
type ChannelLister interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
}

// ChannelPermissionMapper resolves per-channel effective permissions for a
// user across a whole server. Search needs PermCanReadChannel (View AND
// Read, models/role.go:51) — a different bit pair than
// ChannelVisibilityChecker's boolean CanSee (View only) — so it takes the
// full effective Permission bitmask and applies its own check.
type ChannelPermissionMapper interface {
	ResolveUserChannelPermissions(ctx context.Context, userID, serverID string) (*UserChannelPermissions, error)
}

// UserChannelPermissions is a per-channel effective-permission map for one
// user across a server, built by
// ChannelPermissionService.ResolveUserChannelPermissions. Channels absent
// from Overrides carry no per-channel deviation from Base — same
// "channels not in the map inherit the default" convention as
// ChannelVisibilityFilter's Hidden/Granted maps.
type UserChannelPermissions struct {
	IsAdmin   bool
	Base      models.Permission
	Overrides map[string]models.Permission // channelID -> effective permission, override channels only
}

// Effective returns the resolved permission for one channel: the
// override-specific effective permission when present, otherwise Base.
// Admin short-circuits to PermAll regardless of channelID, matching every
// other resolution path in channel_permission_service.go.
func (m *UserChannelPermissions) Effective(channelID string) models.Permission {
	if m.IsAdmin {
		return models.PermAll
	}
	if eff, ok := m.Overrides[channelID]; ok {
		return eff
	}
	return m.Base
}

// SearchService handles server-scoped message search (FTS5).
type SearchService interface {
	Search(ctx context.Context, serverID, userID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error)
}

type searchService struct {
	searchRepo repository.SearchRepository
	channels   ChannelLister
	permMapper ChannelPermissionMapper
}

func NewSearchService(searchRepo repository.SearchRepository, channels ChannelLister, permMapper ChannelPermissionMapper) SearchService {
	return &searchService{searchRepo: searchRepo, channels: channels, permMapper: permMapper}
}

// Search scopes results to serverID and, additionally, to the channels
// userID may actually read (H-05): search used to ignore channel visibility
// permissions entirely, so a member could find messages in channels they
// have no ViewChannel/ReadMessages access to. The filter is applied to both
// the count and the data query inside the repository so TotalCount cannot
// disagree with the page it accompanies.
func (s *searchService) Search(ctx context.Context, serverID, userID, query string, channelID *string, limit, offset int) (*repository.SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("%w: search query is required", pkg.ErrBadRequest)
	}
	if len(query) > 100 {
		return nil, fmt.Errorf("%w: search query must be at most 100 characters", pkg.ErrBadRequest)
	}

	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	allowedChannelIDs, unrestricted, err := s.buildAllowedChannelIDs(ctx, userID, serverID, channelID)
	if err != nil {
		return nil, err
	}
	if !unrestricted && len(allowedChannelIDs) == 0 {
		// The caller cannot read any channel that matches the request (or,
		// with an explicit channel_id, cannot read that one channel) —
		// return empty without ever reaching the database, mirroring
		// ResolveChannelPermissionsBulk's empty-input short circuit.
		return &repository.SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	return s.searchRepo.Search(ctx, query, serverID, channelID, allowedChannelIDs, limit, offset)
}

// buildAllowedChannelIDs resolves userID's PermCanReadChannel-eligible
// channels in serverID into a concrete channel ID list for the repository's
// IN-clause filter. unrestricted=true means the caller is admin: the
// repository must apply no channel filter at all (nil allowedChannelIDs
// would otherwise be ambiguous with "matches nothing").
//
// When channelID is a specific channel (the caller asked to search inside
// one channel), this skips enumerating the server's channels entirely and
// checks only that one channel's effective permission — cheaper, and it
// naturally satisfies "an explicit channel_id filter is intersected with the
// permission set" (N-03/H-05 plan) without any extra logic: the repository
// ANDs channelID and allowedChannelIDs together, so an explicit channel_id
// outside the permitted set yields zero rows either way.
func (s *searchService) buildAllowedChannelIDs(ctx context.Context, userID, serverID string, channelID *string) (allowed []string, unrestricted bool, err error) {
	permMap, err := s.permMapper.ResolveUserChannelPermissions(ctx, userID, serverID)
	if err != nil {
		return nil, false, fmt.Errorf("failed to resolve channel permissions for search: %w", err)
	}
	if permMap.IsAdmin {
		return nil, true, nil
	}

	if channelID != nil {
		if models.PermCanReadChannel(permMap.Effective(*channelID)) {
			return []string{*channelID}, false, nil
		}
		return nil, false, nil
	}

	channels, err := s.channels.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, false, fmt.Errorf("failed to list channels for search visibility: %w", err)
	}

	allowedChannelIDs := make([]string, 0, len(channels))
	for _, ch := range channels {
		if models.PermCanReadChannel(permMap.Effective(ch.ID)) {
			allowedChannelIDs = append(allowedChannelIDs, ch.ID)
		}
	}

	if len(allowedChannelIDs) > maxSearchChannelFilter {
		searchLogger.Warn("search channel allow-list truncated at cap",
			"server_id", serverID, "user_id", userID,
			"allowed", len(allowedChannelIDs), "cap", maxSearchChannelFilter)
		allowedChannelIDs = allowedChannelIDs[:maxSearchChannelFilter]
	}

	return allowedChannelIDs, false, nil
}
