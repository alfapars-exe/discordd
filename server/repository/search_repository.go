package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// SearchResult wraps search results with a total count for pagination.
type SearchResult struct {
	Messages   []models.Message `json:"messages"`
	TotalCount int              `json:"total_count"`
}

// SearchRepository defines data access for FTS5 full-text message search.
// serverID is required. channelID is optional (nil searches all server channels).
// allowedChannelIDs is an optional RBAC scoping filter (H-05): nil means no
// restriction beyond serverID (the admin case — SearchService only omits it
// for admin callers), a non-nil slice (including an empty one) restricts
// results to exactly those channel IDs, applied to both the count and the
// data query so TotalCount never disagrees with the page it accompanies.
type SearchRepository interface {
	Search(ctx context.Context, query string, serverID string, channelID *string, allowedChannelIDs []string, limit, offset int) (*SearchResult, error)
}
