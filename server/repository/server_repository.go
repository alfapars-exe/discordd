package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ServerRepository defines data access for servers and membership.
type ServerRepository interface {
	// ─── Server CRUD ───

	Create(ctx context.Context, server *models.Server) error
	GetByID(ctx context.Context, serverID string) (*models.Server, error)
	Update(ctx context.Context, server *models.Server) error
	// Delete removes a server. CASCADE handles all related data.
	Delete(ctx context.Context, serverID string) error

	// ─── Membership ───

	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
	AddMember(ctx context.Context, serverID, userID string) error
	RemoveMember(ctx context.Context, serverID, userID string) error
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
	GetMemberCount(ctx context.Context, serverID string) (int, error)
	// GetMemberServerIDs returns all server IDs a user belongs to (for WS hub client.ServerIDs).
	GetMemberServerIDs(ctx context.Context, userID string) ([]string, error)

	// ─── Server-scoped nickname (migration 065) ───

	// GetNickname returns the nickname for (server, user) or nil when unset
	// (or when the user isn't a member). Empty string is never returned —
	// SetNickname normalises "" → NULL.
	GetNickname(ctx context.Context, serverID, userID string) (*string, error)
	// SetNickname upserts the membership row's nickname. nil or "" clears.
	// Errors when the user isn't a member of the server.
	SetNickname(ctx context.Context, serverID, userID string, nickname *string) error
	// GetNicknamesForServer batch-fetches nicknames for a server, returning
	// a userID → nickname map. Used by member list endpoints to avoid an
	// N+1 lookup. Users without a nickname are absent from the map.
	GetNicknamesForServer(ctx context.Context, serverID string) (map[string]string, error)

	// UpdateMemberPositions updates a user's server ordering. Runs in a transaction.
	UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error

	// GetMaxMemberPosition returns the highest position value for a user (for position = max+1 on join).
	GetMaxMemberPosition(ctx context.Context, userID string) (int, error)

	// ─── Admin ───

	// ListAllWithStats returns all servers with aggregated stats (members, channels, messages, storage, etc.).
	ListAllWithStats(ctx context.Context) ([]models.AdminServerListItem, error)

	UpdateLastVoiceActivity(ctx context.Context, serverID string) error

	// CountOwnedMqviHostedServers returns the number of platform-managed servers owned by a user.
	CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error)
}
