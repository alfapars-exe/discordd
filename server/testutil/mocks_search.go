package testutil

import (
	"context"

	"github.com/argeinfina/hichat/repository"
)

// ─── SearchRepository mock ───

type MockSearchRepo struct {
	SearchFn func(ctx context.Context, query, serverID string, channelID *string, allowedChannelIDs []string, limit, offset int) (*repository.SearchResult, error)
}

func (m *MockSearchRepo) Search(ctx context.Context, query, serverID string, channelID *string, allowedChannelIDs []string, limit, offset int) (*repository.SearchResult, error) {
	if m.SearchFn != nil {
		return m.SearchFn(ctx, query, serverID, channelID, allowedChannelIDs, limit, offset)
	}
	return &repository.SearchResult{Messages: nil, TotalCount: 0}, nil
}

var _ repository.SearchRepository = (*MockSearchRepo)(nil)
