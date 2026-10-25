// Profile, preference, credential and per-user flag mutations.
package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// IncrementTokenVersion bumps users.token_version by 1, which invalidates
// every outstanding JWT access token for this user via the tv claim check
// in authService.ValidateAccessToken. Used by "logout from all devices".
//
// Refresh tokens are revoked separately by deleting their rows from the
// sessions table — token_version only governs short-lived access tokens.
func (r *sqliteUserRepo) IncrementTokenVersion(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE users SET token_version = token_version + 1 WHERE id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment token_version: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) Update(ctx context.Context, user *models.User) error {
	query := `
		UPDATE users SET username = ?, display_name = ?, avatar_url = ?, custom_status = ?, language = ?, dm_privacy = ?,
			avatar_animated_url = ?, banner_url = ?, banner_animated_url = ?, bio = ?, pronouns = ?, accent_color = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		user.Username, user.DisplayName, user.AvatarURL, user.CustomStatus, user.Language, user.DMPrivacy,
		user.AvatarAnimatedURL, user.BannerURL, user.BannerAnimatedURL, user.Bio, user.Pronouns, user.AccentColor, user.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update user: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteUserRepo) UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error {
	// Stamp last_seen_at only on the offline transition — it's meant to
	// answer "when did this user last go offline", not track every status
	// flip (online/idle/dnd churn while active shouldn't move the marker).
	var query string
	if status == models.UserStatusOffline {
		query = `UPDATE users SET status = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`
	} else {
		query = `UPDATE users SET status = ? WHERE id = ? AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=users.id AND disabled_at IS NOT NULL)`
	}

	result, err := r.db.ExecContext(ctx, query, status, userID)
	if err != nil {
		return fmt.Errorf("failed to update user status: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteUserRepo) UpdatePrefStatus(ctx context.Context, userID string, prefStatus models.UserStatus) error {
	query := `UPDATE users SET pref_status = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, prefStatus, userID)
	if err != nil {
		return fmt.Errorf("failed to update user pref_status: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// UpdateManualPresence atomically persists the current and preferred status.
// Offline transitions also stamp last_seen_at, matching UpdateStatus. For
// non-offline states, the lifecycle guard matches UpdateStatus so a disabled
// account cannot be revived by a late presence callback. Deleted identities
// remain protected by the existing database write barrier.
func (r *sqliteUserRepo) UpdateManualPresence(ctx context.Context, userID string, status models.UserStatus) error {
	switch status {
	case models.UserStatusOnline, models.UserStatusIdle, models.UserStatusDND, models.UserStatusOffline:
	default:
		return fmt.Errorf("%w: invalid user status", pkg.ErrBadRequest)
	}

	result, err := r.db.ExecContext(ctx, `
		UPDATE users
		SET status = ?, pref_status = ?,
			last_seen_at = CASE WHEN ? = 'offline' THEN CURRENT_TIMESTAMP ELSE last_seen_at END
		WHERE id = ? AND deleted_at IS NULL
			AND (? = 'offline' OR NOT EXISTS (
				SELECT 1 FROM account_lifecycle WHERE user_id = users.id AND disabled_at IS NOT NULL
			))`, status, status, status, userID, status)
	if err != nil {
		return fmt.Errorf("failed to update manual presence: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return pkg.ErrNotFound
	}
	return nil
}

func (r *sqliteUserRepo) UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error {
	query := `UPDATE users SET password_hash = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, newPasswordHash, userID)
	if err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// UpdateEmail updates the user's email. nil removes it (NULL), *string sets a new one.
func (r *sqliteUserRepo) UpdateEmail(ctx context.Context, userID string, email *string) error {
	query := `UPDATE users SET email = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, email, userID)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: email already in use", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to update email: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteUserRepo) UpdateWallpaper(ctx context.Context, userID string, wallpaperURL *string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE users SET wallpaper_url = ? WHERE id = ?`, wallpaperURL, userID)
	if err != nil {
		return fmt.Errorf("failed to update wallpaper: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) SetDownloadPromptSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET has_seen_download_prompt = 1 WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set download prompt seen: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) SetWelcomeSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET has_seen_welcome = 1 WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set welcome seen: %w", err)
	}
	return nil
}
