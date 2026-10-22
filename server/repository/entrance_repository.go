package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// EntranceRepository is data access for the entrance-sound tables
// (migration 088). Sound and selection lookups are always scoped by user_id,
// so another user's id is indistinguishable from a missing one. Timestamps
// are returned as RFC3339 UTC (dbTextToRFC3339). List methods return an
// empty, non-nil slice when nothing matches.
type EntranceRepository interface {
	// CreateSoundWithCap inserts s (ID, UserID, Name, URL, DurationMs, Size
	// set by the caller) only while the user holds fewer than maxCount clips
	// — one atomic conditional INSERT. Fills s.CreatedAt. Returns
	// models.ErrEntranceLimitReached when the cap is full.
	CreateSoundWithCap(ctx context.Context, s *models.EntranceSound, maxCount int) error
	// GetSound returns userID's clip id, or models.ErrEntranceSoundNotFound.
	GetSound(ctx context.Context, userID, id string) (*models.EntranceSound, error)
	// ListSounds returns userID's clips, oldest first.
	ListSounds(ctx context.Context, userID string) ([]models.EntranceSound, error)
	// RenameSound sets the name of userID's clip id;
	// models.ErrEntranceSoundNotFound when no row matched.
	RenameSound(ctx context.Context, userID, id, name string) error
	// DeleteSound removes userID's clip id and every selection row pointing
	// at it in one transaction, returning the deleted row's file_url so the
	// caller can remove the file after the commit.
	// models.ErrEntranceSoundNotFound when no row matched.
	DeleteSound(ctx context.Context, userID, id string) (string, error)
	// FileURLsByUser returns the file_url of every clip userID owns.
	FileURLsByUser(ctx context.Context, userID string) ([]string, error)

	// ListSelections returns userID's selection rows (global first).
	ListSelections(ctx context.Context, userID string) ([]models.EntranceSelectionRow, error)
	// UpsertSelection inserts or replaces the (UserID, ScopeServerID) row.
	UpsertSelection(ctx context.Context, row *models.EntranceSelectionRow) error
	// DeleteSelection removes the (userID, scopeServerID) row; no error when
	// it did not exist.
	DeleteSelection(ctx context.Context, userID, scopeServerID string) error
	// ResolveSelection returns the selection that applies to userID in
	// serverID — the server-scoped row wins over the global one — skipping a
	// clip row whose clip no longer exists. nil, nil when nothing applies.
	ResolveSelection(ctx context.Context, userID, serverID string) (*models.ResolvedEntrance, error)

	// GetServerSettings returns serverID's settings, or the defaults
	// (enabled, 5000 ms) when no row exists. DisabledChannelIDs is left
	// empty — see ListDisabledChannels.
	GetServerSettings(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error)
	// PatchServerSettings applies the non-nil fields atomically (upsert).
	PatchServerSettings(ctx context.Context, serverID string, enabled *bool, maxDurationMs *int) error
	// ListDisabledChannels returns the voice channels of serverID with
	// entrance sounds switched off.
	ListDisabledChannels(ctx context.Context, serverID string) ([]string, error)
	// SetChannelDisabled switches entrance sounds off (disabled=true) or
	// back on for channelID of serverID. Idempotent.
	SetChannelDisabled(ctx context.Context, serverID, channelID string, disabled bool) error
	// IsChannelDisabled reports whether entrance sounds are off in channelID.
	IsChannelDisabled(ctx context.Context, channelID string) (bool, error)

	// ListMutes returns the user ids whose entrance sound is muted on serverID.
	ListMutes(ctx context.Context, serverID string) ([]string, error)
	// SetMute mutes (muted=true) or unmutes userID's entrance sound on
	// serverID. Idempotent.
	SetMute(ctx context.Context, serverID, userID string, muted bool) error
	// IsMuted reports whether userID's entrance sound is muted on serverID.
	IsMuted(ctx context.Context, serverID, userID string) (bool, error)
}
