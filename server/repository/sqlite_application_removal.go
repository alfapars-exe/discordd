package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// Removal means permanent identity retirement, not hard deletion of messages.
// API callers additionally need explicit typed consent and fresh MFA proof.
type ApplicationRemovalRepository interface {
	Remove(context.Context, string, string, string, string, string, int64) error
}

type sqliteApplicationRemovalRepo struct{ db database.TxQuerier }

func NewSQLiteApplicationRemovalRepo(db database.TxQuerier) ApplicationRemovalRepository {
	return &sqliteApplicationRemovalRepo{db: db}
}

func (r *sqliteApplicationRemovalRepo) Remove(ctx context.Context, actor, sid, hash, mfa, botID string, now int64) error {
	if actor == "" || sid == "" || hash == "" || botID == "" || actor == botID || now <= 0 {
		return pkg.ErrBadRequest
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return fmt.Errorf("application removal requires a transactional database")
	}
	return database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, database.IsPostgres(raw)); err != nil {
			return err
		}
		// Conditional no-op acquires the writer boundary before any cleanup.
		// No administrative or server-role permission overrides bot ownership.
		res, err := tx.ExecContext(ctx, `UPDATE users SET status=status WHERE id=?1 AND owner_user_id=?2
		AND is_bot=1 AND is_platform_admin=0 AND deleted_at IS NULL
		AND EXISTS(SELECT 1 FROM users a JOIN auth_sessions x ON x.user_id=a.id
		 WHERE a.id=?2 AND a.is_bot=0 AND a.deleted_at IS NULL AND a.is_platform_banned=0 AND a.password_hash=?3
		 AND x.id=?4 AND x.revoked_at IS NULL AND x.expires_at>?5 AND x.token_version=a.token_version
		 AND COALESCE((SELECT secret FROM account_mfa WHERE user_id=a.id),'')=?6
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=a.id AND l.disabled_at IS NOT NULL))`, botID, actor, hash, sid, now, mfa)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrForbidden
		}
		// Corrupted/legacy bots that own resources must not orphan them.
		var servers, children int
		var botHash string
		if err := tx.QueryRowContext(ctx, `SELECT password_hash,(SELECT COUNT(*) FROM servers WHERE owner_id=?1),(SELECT COUNT(*) FROM users WHERE owner_user_id=?1) FROM users WHERE id=?1`, botID).Scan(&botHash, &servers, &children); err != nil {
			return err
		}
		if servers != 0 {
			return ErrDeletionOwnsServers
		}
		if children != 0 {
			return ErrDeletionOwnsBots
		}
		return anonymizeIdentityTx(ctx, tx, botID, botHash, now)
	})
}
