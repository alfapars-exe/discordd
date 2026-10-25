package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteInviteRepo struct {
	db database.TxQuerier
}

func NewSQLiteInviteRepo(db database.TxQuerier) InviteRepository {
	return &sqliteInviteRepo{db: db}
}

func (r *sqliteInviteRepo) GetByCode(ctx context.Context, code string) (*models.Invite, error) {
	query := `
		SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at, channel_id
		FROM invites WHERE code = ?`

	invite := &models.Invite{}
	err := r.db.QueryRowContext(ctx, query, code).Scan(
		&invite.Code, &invite.ServerID, &invite.CreatedBy, &invite.MaxUses,
		&invite.Uses, &invite.ExpiresAt, &invite.CreatedAt, &invite.ChannelID,
	)

	if err == sql.ErrNoRows {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get invite: %w", err)
	}

	return invite, nil
}

// ListByServer returns a server's invites with creator info via LEFT JOIN.
func (r *sqliteInviteRepo) ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error) {
	query := `
		SELECT i.code, i.server_id, i.created_by, i.max_uses, i.uses, i.expires_at, i.created_at, i.channel_id,
		       COALESCE(u.username, ''), u.display_name
		FROM invites i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.server_id = ?
		ORDER BY i.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list invites: %w", err)
	}
	defer rows.Close()

	var invites []models.InviteWithCreator
	for rows.Next() {
		var inv models.InviteWithCreator
		if err := rows.Scan(
			&inv.Code, &inv.ServerID, &inv.CreatedBy, &inv.MaxUses,
			&inv.Uses, &inv.ExpiresAt, &inv.CreatedAt, &inv.ChannelID,
			&inv.CreatorUsername, &inv.CreatorDisplayName,
		); err != nil {
			return nil, fmt.Errorf("failed to scan invite: %w", err)
		}
		invites = append(invites, inv)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate invites: %w", err)
	}

	return invites, nil
}

func (r *sqliteInviteRepo) Create(ctx context.Context, invite *models.Invite) error {
	query := `INSERT INTO invites (code, server_id, created_by, max_uses, uses, expires_at, channel_id)
		VALUES (?, ?, ?, ?, 0, ?, NULL)`
	args := []any{invite.Code, invite.ServerID, invite.CreatedBy, invite.MaxUses, invite.ExpiresAt}
	if invite.ChannelID != nil {
		// The SELECT is an atomic scope check: a caller cannot attach an invite
		// to a channel belonging to another server by forging channel_id.
		query = `INSERT INTO invites (code, server_id, created_by, max_uses, uses, expires_at, channel_id)
			SELECT ?, ?, ?, ?, 0, ?, id FROM channels WHERE id = ? AND server_id = ? AND type <> 'thread'`
		args = append(args, *invite.ChannelID, invite.ServerID)
	}
	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to create invite: %w", err)
	}
	if invite.ChannelID != nil {
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to verify invite channel: %w", err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: invite channel is outside this server", pkg.ErrBadRequest)
		}
	}

	return nil
}

func (r *sqliteInviteRepo) Delete(ctx context.Context, code string) error {
	query := `DELETE FROM invites WHERE code = ?`

	result, err := r.db.ExecContext(ctx, query, code)
	if err != nil {
		return fmt.Errorf("failed to delete invite: %w", err)
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

func (r *sqliteInviteRepo) IncrementUses(ctx context.Context, code string) error {
	query := `UPDATE invites SET uses = uses + 1 WHERE code = ?`

	result, err := r.db.ExecContext(ctx, query, code)
	if err != nil {
		return fmt.Errorf("failed to increment invite uses: %w", err)
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
