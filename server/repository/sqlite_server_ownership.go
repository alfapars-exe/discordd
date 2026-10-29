package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// ServerOwnershipRepository is separate from administrative/server CRUD: no
// platform-admin or generic ManageServer permission substitutes for ownership.
// A service must supply fresh password/MFA proof and active session identity.
type ServerOwnershipRepository interface {
	Transfer(context.Context, string, string, string, string, string, string, int64) (*models.Server, error)
}
type sqliteServerOwnershipRepo struct{ db database.TxQuerier }

func NewSQLiteServerOwnershipRepo(db database.TxQuerier) ServerOwnershipRepository {
	return &sqliteServerOwnershipRepo{db: db}
}
func (r *sqliteServerOwnershipRepo) Transfer(ctx context.Context, actor, sid, hash, mfa, serverID, target string, now int64) (*models.Server, error) {
	if actor == "" || sid == "" || hash == "" || serverID == "" || target == "" || actor == target || now <= 0 {
		return nil, pkg.ErrBadRequest
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("ownership transfer requires a transactional database")
	}
	var result *models.Server
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// One conditional UPDATE acquires the write boundary and checks both
		// identities, membership, bans, session generation, password and MFA.
		updated, err := tx.ExecContext(ctx, `UPDATE servers SET owner_id=?1 WHERE id=?2 AND owner_id=?3
		AND EXISTS(SELECT 1 FROM users a JOIN auth_sessions x ON x.user_id=a.id
		 WHERE a.id=?3 AND a.password_hash=?4 AND a.is_bot=0 AND a.deleted_at IS NULL AND a.is_platform_banned=0
		 AND x.id=?5 AND x.revoked_at IS NULL AND x.expires_at>?6 AND x.token_version=a.token_version
		 AND COALESCE((SELECT secret FROM account_mfa WHERE user_id=a.id),'')=?7
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=a.id AND disabled_at IS NOT NULL))
		AND EXISTS(SELECT 1 FROM users t JOIN server_members sm ON sm.user_id=t.id
		 WHERE t.id=?1 AND sm.server_id=?2 AND t.is_bot=0 AND t.deleted_at IS NULL AND t.is_platform_banned=0
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=t.id AND disabled_at IS NOT NULL)
		 AND NOT EXISTS(SELECT 1 FROM bans b WHERE b.user_id=t.id AND b.server_id=?2 AND (b.expires_at IS NULL OR b.expires_at>CURRENT_TIMESTAMP))
		 AND (t.is_platform_admin=1 OR NOT EXISTS(SELECT 1 FROM livekit_instances li WHERE li.id=servers.livekit_instance_id AND li.is_platform_managed=1)
		 OR NOT EXISTS(SELECT 1 FROM servers other JOIN livekit_instances li ON li.id=other.livekit_instance_id WHERE other.owner_id=t.id AND other.id<>?2 AND li.is_platform_managed=1)))`, target, serverID, actor, hash, sid, now, mfa)
		if err != nil {
			return err
		}
		n, err := updated.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrForbidden
		}
		rows, err := tx.QueryContext(ctx, `SELECT id FROM roles WHERE server_id=? AND is_owner=1`, serverID)
		if err != nil {
			return err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		scanErr := rows.Err()
		rows.Close()
		if scanErr != nil {
			return scanErr
		}
		if len(ids) != 1 {
			return fmt.Errorf("ownership role invariant unavailable")
		}
		// Clear every assignment of this server's owner role (including any
		// inconsistent historical extra grant); ordinary roles stay intact.
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_roles WHERE role_id=?`, ids[0]); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?,?,?)`, target, ids[0], serverID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO audit_logs(server_id,actor_user_id,target_user_id,event_type,metadata,actor_snapshot,target_snapshot)
		VALUES(?1,?2,?3,?4,`+snapshotObjectSQL(r.db)+`('old_owner_id',?2,'new_owner_id',?3),
		(SELECT `+snapshotObjectSQL(r.db)+`('id',id,'username',username,'display_name',COALESCE(display_name,''),'avatar_url',COALESCE(avatar_url,'')) FROM users WHERE id=?2),
		(SELECT `+snapshotObjectSQL(r.db)+`('id',id,'username',username,'display_name',COALESCE(display_name,''),'avatar_url',COALESCE(avatar_url,'')) FROM users WHERE id=?3))`, serverID, actor, target, models.AuditEventServerOwnershipTransfer); err != nil {
			return err
		}
		result, err = NewSQLiteServerRepo(tx).GetByID(ctx, serverID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
