// Admin-facing user listing, activity stamping, and platform-admin toggling.
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// ListAllUsersWithStats returns all users with aggregated stats via correlated subqueries.
func (r *sqliteUserRepo) ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error) {
	query := `
		SELECT
			u.id,
			u.username,
			u.display_name,
			u.avatar_url,
			u.is_platform_admin,
			u.is_platform_banned,
			u.created_at,
			u.status,
			(SELECT MAX(val) FROM (
				SELECT MAX(m.created_at) AS val FROM messages m WHERE m.user_id = u.id
				UNION ALL
				SELECT u.last_voice_activity
			) sub WHERE val IS NOT NULL),
			(SELECT COUNT(*) FROM messages m2 WHERE m2.user_id = u.id),
			COALESCE(
				(SELECT SUM(a.file_size) FROM attachments a
				 INNER JOIN messages m3 ON a.message_id = m3.id
				 WHERE m3.user_id = u.id), 0
			) / 1048576.0,
			(SELECT COUNT(*) FROM servers sv
			 LEFT JOIN livekit_instances li ON sv.livekit_instance_id = li.id
			 WHERE sv.owner_id = u.id AND COALESCE(li.is_platform_managed, 0) = 0),
			(SELECT COUNT(*) FROM servers sv2
			 LEFT JOIN livekit_instances li2 ON sv2.livekit_instance_id = li2.id
			 WHERE sv2.owner_id = u.id AND COALESCE(li2.is_platform_managed, 0) = 1),
			(SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id),
			(SELECT COUNT(*) FROM bans b WHERE b.user_id = u.id)
		FROM users u
		ORDER BY u.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list all users with stats: %w", err)
	}
	return scanRows(rows, "admin user", func(rows *sql.Rows) (models.AdminUserListItem, error) {
		var u models.AdminUserListItem
		err := rows.Scan(
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL,
			&u.IsPlatformAdmin, &u.IsPlatformBanned, &u.CreatedAt, &u.Status,
			&u.LastActivity, &u.MessageCount, &u.StorageMB,
			&u.OwnedSelfServers, &u.OwnedMqviServers,
			&u.MemberServerCount, &u.BanCount,
		)
		return u, err
	})
}

func (r *sqliteUserRepo) UpdateLastVoiceActivity(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE users SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update user voice activity: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE users SET is_platform_admin = ? WHERE id = ?",
		isAdmin, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set platform admin: %w", err)
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
