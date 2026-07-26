// Package repository — ServerRepository SQLite implementation.
// Multi-server architecture: servers + server_members tables.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteServerRepo struct {
	db database.TxQuerier
}

func NewSQLiteServerRepo(db database.TxQuerier) ServerRepository {
	return &sqliteServerRepo{db: db}
}

// ─── Server CRUD ───

func (r *sqliteServerRepo) Create(ctx context.Context, server *models.Server) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create server: %w", err)
	}
	server.ID = id

	query := `
		INSERT INTO servers (id, name, icon_url, owner_id, invite_required, e2ee_enabled, livekit_instance_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		server.ID, server.Name, server.IconURL, server.OwnerID,
		server.InviteRequired, server.E2EEEnabled, server.LiveKitInstanceID,
	); err != nil {
		return fmt.Errorf("failed to create server: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM servers WHERE id = ?", server.ID).Scan(&server.CreatedAt)

	return nil
}

func (r *sqliteServerRepo) GetByID(ctx context.Context, serverID string) (*models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, invite_required, e2ee_enabled, livekit_instance_id, afk_timeout_minutes, created_at
		FROM servers WHERE id = ?`

	s := &models.Server{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
		&s.InviteRequired, &s.E2EEEnabled, &s.LiveKitInstanceID, &s.AFKTimeoutMinutes, &s.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	return s, nil
}

func (r *sqliteServerRepo) Update(ctx context.Context, server *models.Server) error {
	query := `
		UPDATE servers SET name = ?, icon_url = ?, invite_required = ?, e2ee_enabled = ?, livekit_instance_id = ?, afk_timeout_minutes = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		server.Name, server.IconURL, server.InviteRequired,
		server.E2EEEnabled, server.LiveKitInstanceID, server.AFKTimeoutMinutes, server.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server: %w", err)
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

// Delete removes the server and every row scoped to it (see
// deleteServerCascade for why that isn't just `DELETE FROM servers` —
// several child tables have no enforced foreign key). Callers that need
// this atomic with other work should bind the repo to a *sql.Tx first
// (NewSQLiteServerRepo(tx)), matching the database.WithTx pattern
// CreateServer already uses.
func (r *sqliteServerRepo) Delete(ctx context.Context, serverID string) error {
	if err := deleteServerCascade(ctx, r.db, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}
	return nil
}

// ─── Membership ───

func (r *sqliteServerRepo) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	// Sorted by user's custom position, with joined_at as tiebreaker.
	query := `
		SELECT s.id, s.name, s.icon_url
		FROM servers s
		INNER JOIN server_members sm ON s.id = sm.server_id
		WHERE sm.user_id = ?
		ORDER BY sm.position ASC, sm.joined_at ASC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user servers: %w", err)
	}
	return scanRows(rows, "server", func(rows *sql.Rows) (models.ServerListItem, error) {
		var s models.ServerListItem
		err := rows.Scan(&s.ID, &s.Name, &s.IconURL)
		return s, err
	})
}

func (r *sqliteServerRepo) AddMember(ctx context.Context, serverID, userID string) error {
	// New member appended at end: position = max + 1 (atomic via subquery).
	query := `
		INSERT OR IGNORE INTO server_members (server_id, user_id, position)
		VALUES (?, ?, COALESCE((SELECT MAX(position) FROM server_members WHERE user_id = ?), -1) + 1)`

	_, err := r.db.ExecContext(ctx, query, serverID, userID, userID)
	if err != nil {
		return fmt.Errorf("failed to add server member: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) RemoveMember(ctx context.Context, serverID, userID string) error {
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID)
	if err != nil {
		return fmt.Errorf("failed to remove server member: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	// Hard-delete all role assignments for this user in this server.
	// Without this, leftover user_roles let the user pass permission checks
	// (e.g. allowedViewers) and keep receiving broadcasts after leaving.
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM user_roles WHERE user_id = ? AND server_id = ?`,
		userID, serverID); err != nil {
		return fmt.Errorf("failed to clean up user roles on member removal: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) IsMember(ctx context.Context, serverID, userID string) (bool, error) {
	query := `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? LIMIT 1`

	var dummy int
	err := r.db.QueryRowContext(ctx, query, serverID, userID).Scan(&dummy)

	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check server membership: %w", err)
	}

	return true, nil
}

func (r *sqliteServerRepo) GetMemberCount(ctx context.Context, serverID string) (int, error) {
	query := `SELECT COUNT(*) FROM server_members WHERE server_id = ?`

	var count int
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to get member count: %w", err)
	}

	return count, nil
}

// GetNickname returns the per-server nickname or nil when unset. NULL and
// empty string are treated identically — caller never has to think about
// the difference.
func (r *sqliteServerRepo) GetNickname(ctx context.Context, serverID, userID string) (*string, error) {
	var nick sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT nickname FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	).Scan(&nick)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get server nickname: %w", err)
	}
	if !nick.Valid || nick.String == "" {
		return nil, nil
	}
	s := nick.String
	return &s, nil
}

// SetNickname writes the nickname column on the membership row. Pass nil
// or a pointer to "" to clear. Returns ErrNotFound when the user isn't a
// member of the server (no row to update).
func (r *sqliteServerRepo) SetNickname(ctx context.Context, serverID, userID string, nickname *string) error {
	// Normalise: empty string → NULL so reads stay consistent (only one
	// "no nickname" representation in the DB).
	var v interface{}
	if nickname != nil && *nickname != "" {
		v = *nickname
	}
	res, err := r.db.ExecContext(ctx,
		`UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?`,
		v, serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("set server nickname: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return pkg.ErrNotFound
	}
	return nil
}

// GetNicknamesForServer — batch fetch for member list rendering. Returns
// only set nicknames so an empty map is a valid "no one customised their
// name on this server" result, not an error.
func (r *sqliteServerRepo) GetNicknamesForServer(ctx context.Context, serverID string) (map[string]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT user_id, nickname FROM server_members
		 WHERE server_id = ? AND nickname IS NOT NULL AND nickname != ''`,
		serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("list server nicknames: %w", err)
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var uid, nick string
		if err := rows.Scan(&uid, &nick); err != nil {
			return nil, fmt.Errorf("scan server nickname: %w", err)
		}
		out[uid] = nick
	}
	return out, rows.Err()
}

func (r *sqliteServerRepo) UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("UpdateMemberPositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `UPDATE server_members SET position = ? WHERE server_id = ? AND user_id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare position update: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		if _, err := stmt.ExecContext(ctx, item.Position, item.ID, userID); err != nil {
			return fmt.Errorf("failed to update position for server %s: %w", item.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit position update: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) GetMaxMemberPosition(ctx context.Context, userID string) (int, error) {
	query := `SELECT COALESCE(MAX(position), -1) FROM server_members WHERE user_id = ?`

	var maxPos int
	err := r.db.QueryRowContext(ctx, query, userID).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max member position: %w", err)
	}

	return maxPos, nil
}

// ─── Admin ───

// ListAllWithStats returns all servers with aggregated stats via correlated subqueries.
func (r *sqliteServerRepo) ListAllWithStats(ctx context.Context) ([]models.AdminServerListItem, error) {
	query := `
		SELECT
			s.id,
			s.name,
			s.icon_url,
			s.owner_id,
			COALESCE(u.username, ''),
			s.created_at,
			CASE
				WHEN s.livekit_instance_id IS NOT NULL AND li.id IS NULL THEN 1
				ELSE COALESCE(li.is_platform_managed, 0)
			END,
			s.livekit_instance_id,
			(SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id),
			(SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id),
			(SELECT COUNT(*) FROM messages m
			 INNER JOIN channels c2 ON m.channel_id = c2.id
			 WHERE c2.server_id = s.id),
			COALESCE(
				(SELECT SUM(a.file_size) FROM attachments a
				 INNER JOIN messages m2 ON a.message_id = m2.id
				 INNER JOIN channels c3 ON m2.channel_id = c3.id
				 WHERE c3.server_id = s.id), 0
			) / 1048576.0,
			MAX(
				COALESCE((SELECT MAX(m3.created_at) FROM messages m3
				 INNER JOIN channels c4 ON m3.channel_id = c4.id
				 WHERE c4.server_id = s.id), ''),
				COALESCE(s.last_voice_activity, '')
			)
		FROM servers s
		LEFT JOIN users u ON s.owner_id = u.id
		LEFT JOIN livekit_instances li ON s.livekit_instance_id = li.id
		ORDER BY s.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list all servers with stats: %w", err)
	}
	return scanRows(rows, "admin server", func(rows *sql.Rows) (models.AdminServerListItem, error) {
		var s models.AdminServerListItem
		err := rows.Scan(
			&s.ID, &s.Name, &s.IconURL, &s.OwnerID, &s.OwnerUsername,
			&s.CreatedAt, &s.IsPlatformManaged, &s.LiveKitInstanceID,
			&s.MemberCount, &s.ChannelCount, &s.MessageCount,
			&s.StorageMB, &s.LastActivity,
		)
		return s, err
	})
}

func (r *sqliteServerRepo) UpdateLastVoiceActivity(ctx context.Context, serverID string) error {
	query := `UPDATE servers SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`
	_, err := r.db.ExecContext(ctx, query, serverID)
	if err != nil {
		return fmt.Errorf("failed to update last voice activity: %w", err)
	}
	return nil
}

func (r *sqliteServerRepo) GetMemberServerIDs(ctx context.Context, userID string) ([]string, error) {
	query := `SELECT server_id FROM server_members WHERE user_id = ?`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get member server ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan server id: %w", err)
		}
		ids = append(ids, id)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating server ids: %w", err)
	}

	return ids, nil
}

func (r *sqliteServerRepo) CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error) {
	query := `
		SELECT COUNT(*) FROM servers s
		JOIN livekit_instances li ON s.livekit_instance_id = li.id
		WHERE s.owner_id = ? AND li.is_platform_managed = true`

	var count int
	if err := r.db.QueryRowContext(ctx, query, ownerID).Scan(&count); err != nil {
		return 0, fmt.Errorf("failed to count owned mqvi-hosted servers: %w", err)
	}
	return count, nil
}
