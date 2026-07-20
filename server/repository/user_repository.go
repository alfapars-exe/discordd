package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// UserRepository defines data access for users.
type UserRepository interface {
	Create(ctx context.Context, user *models.User) error
	// CreateWithSession creates a user and an associated session atomically
	// — either both rows commit or neither does. Used by AuthService.Register
	// to close the orphaned-user-row bug where a session-insert failure left
	// a committed, tokenless user row behind (client saw 500; a retry then
	// hit 409).
	CreateWithSession(ctx context.Context, user *models.User, session *models.Session) error
	GetByID(ctx context.Context, id string) (*models.User, error)
	GetByUsername(ctx context.Context, username string) (*models.User, error)
	GetAll(ctx context.Context) ([]models.User, error)
	Update(ctx context.Context, user *models.User) error
	UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error
	UpdatePrefStatus(ctx context.Context, userID string, prefStatus models.UserStatus) error
	UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error
	// IncrementTokenVersion bumps users.token_version; every outstanding
	// JWT access token for this user is invalidated on its next validation.
	// Used by "logout from all devices" and recommended on password change.
	IncrementTokenVersion(ctx context.Context, userID string) error
	// UpdateEmail sets or clears the user's email. nil removes, *string sets.
	UpdateEmail(ctx context.Context, userID string, email *string) error
	UpdateWallpaper(ctx context.Context, userID string, wallpaperURL *string) error
	GetByEmail(ctx context.Context, email string) (*models.User, error)
	Count(ctx context.Context) (int, error)
	// Delete removes a user. FK cascade handles user_roles, sessions, etc.
	Delete(ctx context.Context, id string) error

	// ─── Admin ───

	// ListAllUsersWithStats returns all users with aggregated stats (message count, storage, bans, etc.).
	ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error)

	UpdateLastVoiceActivity(ctx context.Context, userID string) error

	// ─── Platform Ban ───

	// PlatformBan blocks login, WS connect, and re-registration with the same email.
	PlatformBan(ctx context.Context, userID, reason, bannedBy string) error
	PlatformUnban(ctx context.Context, userID string) error
	// IsEmailPlatformBanned checks if an email belongs to a platform-banned user.
	IsEmailPlatformBanned(ctx context.Context, email string) (bool, error)
	// DeleteAllMessagesByUser removes all messages (server + DM) and attachments for a user.
	DeleteAllMessagesByUser(ctx context.Context, userID string) error
	// HardDeleteUser permanently deletes a user and all cascaded data.
	// Owned servers must be cleaned up beforehand (no CASCADE on servers.owner_id).
	HardDeleteUser(ctx context.Context, userID string) error

	// ─── Download Prompt ───

	SetDownloadPromptSeen(ctx context.Context, userID string) error
	SetWelcomeSeen(ctx context.Context, userID string) error

	// ─── Platform Admin ───

	SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error
}
