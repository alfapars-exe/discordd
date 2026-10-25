package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

var (
	ErrDeletionOwnsServers = errors.New("transfer server ownership before deleting account")
	ErrDeletionOwnsBots    = errors.New("remove or transfer owned applications before deleting account")
	ErrDeletionAdmin       = errors.New("hand off platform administration before deleting account")
)

// Shared ciphertext is never decrypted, rewritten or removed here.
type AccountAnonymizationRepository interface {
	Anonymize(context.Context, string, string, string, string, int64) error
}
type sqliteAccountAnonymizationRepo struct{ db database.TxQuerier }

func NewSQLiteAccountAnonymizationRepo(db database.TxQuerier) AccountAnonymizationRepository {
	return &sqliteAccountAnonymizationRepo{db: db}
}

func (r *sqliteAccountAnonymizationRepo) Anonymize(ctx context.Context, owner, sid, expectedHash, expectedMFA string, now int64) error {
	if owner == "" || sid == "" || expectedHash == "" || now <= 0 {
		return pkg.ErrBadRequest
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return fmt.Errorf("account anonymization requires a transactional database")
	}
	return database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if database.IsPostgres(raw) {
			if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(7341982002)"); err != nil {
				return err
			}
		}
		// Check credential/session affinity before revealing ownership blockers.
		var admin, servers, bots int
		err := tx.QueryRowContext(ctx, `SELECT u.is_platform_admin,
		 (SELECT COUNT(*) FROM servers WHERE owner_id=u.id),
		 (SELECT COUNT(*) FROM users WHERE owner_user_id=u.id)
		 FROM users u WHERE u.id=? AND u.password_hash=? AND u.is_bot=0 AND u.deleted_at IS NULL
		 AND EXISTS(SELECT 1 FROM auth_sessions a WHERE a.id=? AND a.user_id=u.id AND a.token_version=u.token_version AND a.revoked_at IS NULL AND a.expires_at>?)
		 AND COALESCE((SELECT secret FROM account_mfa WHERE user_id=u.id),'')=?
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, owner, expectedHash, sid, now, expectedMFA).Scan(&admin, &servers, &bots)
		if errors.Is(err, sql.ErrNoRows) {
			return pkg.ErrUnauthorized
		}
		if err != nil {
			return err
		}
		if admin != 0 {
			return ErrDeletionAdmin
		}
		if servers > 0 {
			return ErrDeletionOwnsServers
		}
		if bots > 0 {
			return ErrDeletionOwnsBots
		}
		return anonymizeIdentityTx(ctx, tx, owner, expectedHash, now)
	})
}

// Shared by human self-deletion and owner-authorized bot retirement. Callers
// must acquire a write boundary and verify credentials/ownership before entry.
// This helper never deletes a shared conversation or authored message.
func anonymizeIdentityTx(ctx context.Context, tx *sql.Tx, owner, expectedHash string, now int64) error {
	// Capture only personal assets; shared attachment rows/URLs are untouched.
	_, err := tx.ExecContext(ctx, `INSERT INTO account_asset_cleanup(file_url,requested_at)
		 SELECT file_url,? FROM (
		 SELECT avatar_url AS file_url FROM users WHERE id=? UNION SELECT avatar_animated_url FROM users WHERE id=?
		 UNION SELECT banner_url FROM users WHERE id=? UNION SELECT banner_animated_url FROM users WHERE id=?
		 UNION SELECT wallpaper_url FROM users WHERE id=? UNION SELECT file_url FROM user_entrance_sounds WHERE user_id=?)
		 WHERE file_url IS NOT NULL AND file_url<>''
		 ON CONFLICT(file_url) DO NOTHING`, now, owner, owner, owner, owner, owner, owner)
	if err != nil {
		return err
	}
	// Preserve shared group history while retiring this participant. Sole-member
	// groups have no remaining audience; shared groups transfer ownership and
	// rotate their message/media epoch before membership is removed.
	if _, err = tx.ExecContext(ctx, `INSERT INTO account_asset_cleanup(file_url,requested_at)
		 SELECT a.file_url,? FROM group_dm_attachments a
		 JOIN group_dm_messages msg ON msg.id=a.group_message_id
		 JOIN group_dm_channels g ON g.id=msg.group_id
		 WHERE g.owner_id=? AND NOT EXISTS(
		  SELECT 1 FROM group_dm_members m WHERE m.group_id=g.id AND m.user_id<>?
		 ) ON CONFLICT(file_url) DO NOTHING`, now, owner, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM group_dm_channels WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM group_dm_members m WHERE m.group_id=group_dm_channels.id AND m.user_id<>?)`, owner, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_channels SET owner_id=(SELECT user_id FROM group_dm_members m WHERE m.group_id=group_dm_channels.id AND m.user_id<>? ORDER BY joined_at,user_id LIMIT 1) WHERE owner_id=?`, owner, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_channels SET key_epoch=key_epoch+1,updated_at=CURRENT_TIMESTAMP WHERE EXISTS(SELECT 1 FROM group_dm_members m WHERE m.group_id=group_dm_channels.id AND m.user_id=?)`, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM group_dm_reactions WHERE user_id=?`, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM group_dm_reads WHERE user_id=?`, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM group_dm_members WHERE user_id=?`, owner); err != nil {
		return err
	}

	// Every statement is explicit: remote foreign-key enforcement is not
	// assumed. In particular, do NOT delete dm_channels or message authors.
	for _, query := range anonymizationPrivateDeletes {
		if _, err := tx.ExecContext(ctx, query, owner); err != nil {
			return fmt.Errorf("anonymization cleanup: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM friendship_anniversary_deliveries WHERE recipient_id=? OR friendship_id IN (
		SELECT id FROM friendships WHERE user_id=? OR friend_id=?)`, owner, owner, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM stream_start_deliveries WHERE recipient_id=? OR actor_id=?`, owner, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM friendships WHERE user_id=? OR friend_id=?`, owner, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM notifications WHERE user_id=? OR actor_id=?`, owner, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE audit_logs SET actor_snapshot=NULL,metadata='{}' WHERE actor_user_id=?`, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE audit_logs SET target_snapshot=NULL,metadata='{}' WHERE target_user_id=?`, owner); err != nil {
		return err
	}
	// Other recipients' sealed sender-key envelopes survive with shared
	// history. Only this account's delivery envelopes and private backup go.
	if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?),user_agent='',client_type='unknown' WHERE user_id=?`, now, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id=?`, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET disabled_at=excluded.disabled_at,version=account_lifecycle.version+1`, owner, now); err != nil {
		return err
	}
	// Email invalidation performs a nested users update. Run it before the
	// immutable tombstone is set, so that trigger cannot reject our commit.
	if _, err := tx.ExecContext(ctx, `UPDATE users SET email=NULL,email_verified_at=NULL WHERE id=?`, owner); err != nil {
		return err
	}
	// Final update makes the row immutable. A random replacement username
	// frees the original without preserving it in a recovery table. The
	// stable internal ID remains linkable through shared authorship; this is
	// identity stripping, not a promise of unlinkable anonymous history.
	result, err := tx.ExecContext(ctx, `UPDATE users SET username='deleted_'||lower(hex(randomblob(16))),display_name='Deleted User',
		 avatar_url=NULL,avatar_animated_url=NULL,banner_url=NULL,banner_animated_url=NULL,wallpaper_url=NULL,bio=NULL,pronouns=NULL,accent_color=NULL,
		 password_hash='!deleted!',status='offline',pref_status='offline',custom_status=NULL,owner_user_id=NULL,
		 last_seen_at=NULL,last_voice_activity=NULL,language='en',dm_privacy='friends_only',
		 created_at='1970-01-01 00:00:00',token_version=token_version+1,deleted_at=? WHERE id=? AND password_hash=? AND deleted_at IS NULL`, now, owner, expectedHash)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrUnauthorized
	}
	return nil
}

var anonymizationPrivateDeletes = []string{
	`DELETE FROM bot_tokens WHERE bot_user_id=?`,
	`DELETE FROM sessions WHERE user_id=?`,
	`DELETE FROM password_reset_tokens WHERE user_id=?`,
	`DELETE FROM account_email_tokens WHERE user_id=?`,
	`DELETE FROM email_unsubscribe_tokens WHERE user_id=?`,
	`DELETE FROM account_mfa WHERE user_id=?`,
	`DELETE FROM device_one_time_prekeys WHERE user_id=?`,
	`DELETE FROM user_devices WHERE user_id=?`,
	`DELETE FROM e2ee_key_backups WHERE user_id=?`,
	`DELETE FROM channel_group_sessions WHERE sender_user_id=?`,
	`DELETE FROM channel_sender_key_envelopes WHERE recipient_user_id=?`,
	`DELETE FROM user_preferences WHERE user_id=?`,
	`DELETE FROM user_dm_settings WHERE user_id=?`,
	`DELETE FROM channel_reads WHERE user_id=?`,
	`DELETE FROM dm_reads WHERE user_id=?`,
	`DELETE FROM server_mutes WHERE user_id=?`,
	`DELETE FROM channel_mutes WHERE user_id=?`,
	`DELETE FROM saved_messages WHERE user_id=?`,
	`DELETE FROM spam_inbox WHERE user_id=?`,
	`DELETE FROM private_media_labels WHERE user_id=?`,
	`DELETE FROM application_game_grants WHERE user_id=?`,
	`DELETE FROM application_game_grants WHERE bot_user_id=?`,
	`DELETE FROM user_notes WHERE owner_user_id=?`,
	`DELETE FROM app_logs WHERE user_id=?`,
	`DELETE FROM user_roles WHERE user_id=?`,
	`DELETE FROM server_members WHERE user_id=?`,
	`DELETE FROM server_event_rsvps WHERE user_id=?`,
	`DELETE FROM server_event_deliveries WHERE user_id=?`,
	`DELETE FROM invites WHERE created_by=?`,
	`DELETE FROM user_badges WHERE user_id=?`,
	`DELETE FROM user_equipped WHERE user_id=?`,
	`DELETE FROM user_cosmetic_plain_servers WHERE user_id=?`,
	`DELETE FROM user_cosmetics WHERE user_id=?`,
	`DELETE FROM user_entrance_selection WHERE user_id=?`,
	`DELETE FROM server_entrance_mutes WHERE user_id=?`,
	`DELETE FROM user_entrance_sounds WHERE user_id=?`,
}
