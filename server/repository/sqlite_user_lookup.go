// Read-only user lookups: fetch by id/username/email, list all, and count.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (r *sqliteUserRepo) GetByID(ctx context.Context, id string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at, token_version, created_at, is_bot, owner_user_id, last_seen_at,
			avatar_animated_url, banner_url, banner_animated_url, bio, pronouns, accent_color
		FROM users WHERE id = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.TokenVersion,
		&user.CreatedAt,
		&user.IsBot, &user.OwnerUserID, &user.LastSeenAt,
		&user.AvatarAnimatedURL, &user.BannerURL, &user.BannerAnimatedURL, &user.Bio, &user.Pronouns, &user.AccentColor,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by id: %w", err)
	}

	return user, nil
}

func (r *sqliteUserRepo) GetByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at, token_version, created_at, is_bot, owner_user_id,
			avatar_animated_url, banner_url, banner_animated_url, bio, pronouns, accent_color
		FROM users WHERE username = ? COLLATE NOCASE`

	if database.IsPostgres(r.db) {
		query = strings.Replace(query, "username = ? COLLATE NOCASE", "hichat_ascii_lower(username) = hichat_ascii_lower(?)", 1)
	}

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.TokenVersion,
		&user.CreatedAt,
		&user.IsBot, &user.OwnerUserID,
		&user.AvatarAnimatedURL, &user.BannerURL, &user.BannerAnimatedURL, &user.Bio, &user.Pronouns, &user.AccentColor,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by username: %w", err)
	}

	return user, nil
}

// ListServerMemberProfiles reads the fields used by ToMemberWithRoles.
func (r *sqliteUserRepo) ListServerMemberProfiles(ctx context.Context, serverID string) ([]models.User, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT u.id, u.username, u.display_name, u.avatar_url,
		u.status, u.pref_status, u.custom_status, u.created_at, u.last_seen_at, u.avatar_animated_url,
		u.banner_url, u.banner_animated_url, u.bio, u.pronouns, u.accent_color
		FROM server_members m JOIN users u ON u.id = m.user_id
		WHERE m.server_id = ? ORDER BY u.username`, serverID)
	if err != nil {
		return nil, fmt.Errorf("list member profiles: %w", err)
	}
	return scanRows(rows, "member profile", func(rows *sql.Rows) (models.User, error) {
		var u models.User
		err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.Status, &u.PrefStatus,
			&u.CustomStatus, &u.CreatedAt, &u.LastSeenAt, &u.AvatarAnimatedURL, &u.BannerURL,
			&u.BannerAnimatedURL, &u.Bio, &u.Pronouns, &u.AccentColor)
		return u, err
	})
}

func (r *sqliteUserRepo) GetAll(ctx context.Context) ([]models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at, is_bot, owner_user_id, last_seen_at,
			avatar_animated_url, banner_url, banner_animated_url, bio, pronouns, accent_color
		FROM users ORDER BY username`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}
	return scanRows(rows, "user", func(rows *sql.Rows) (models.User, error) {
		var user models.User
		err := rows.Scan(
			&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
			&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
			&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
			&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
			&user.CreatedAt,
			&user.IsBot, &user.OwnerUserID, &user.LastSeenAt,
			&user.AvatarAnimatedURL, &user.BannerURL, &user.BannerAnimatedURL, &user.Bio, &user.Pronouns, &user.AccentColor,
		)
		return user, err
	})
}

func (r *sqliteUserRepo) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at, is_bot, owner_user_id,
			avatar_animated_url, banner_url, banner_animated_url, bio, pronouns, accent_color
		FROM users WHERE email = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.CreatedAt,
		&user.IsBot, &user.OwnerUserID,
		&user.AvatarAnimatedURL, &user.BannerURL, &user.BannerAnimatedURL, &user.Bio, &user.Pronouns, &user.AccentColor,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by email: %w", err)
	}

	return user, nil
}

func (r *sqliteUserRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count users: %w", err)
	}
	return count, nil
}
