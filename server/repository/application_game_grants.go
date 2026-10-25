package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (r *BotRepository) RegisterGameIdentity(ctx context.Context, ownerID, botID string) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO application_game_identities(bot_user_id)
		SELECT b.id FROM users b JOIN users owner ON owner.id=b.owner_user_id
		WHERE b.id=? AND b.owner_user_id=? AND b.is_bot=1 AND b.deleted_at IS NULL
		AND owner.is_bot=0 AND owner.deleted_at IS NULL
		ON CONFLICT(bot_user_id) DO UPDATE SET bot_user_id=excluded.bot_user_id`, botID, ownerID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrNotFound
	}
	return nil
}

func (r *BotRepository) OwnedGameIdentityIDs(ctx context.Context, ownerID string) (map[string]bool, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT g.bot_user_id FROM application_game_identities g
		JOIN users b ON b.id=g.bot_user_id WHERE b.owner_user_id=? AND b.is_bot=1 AND b.deleted_at IS NULL`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

const applicationGameGrantSelect = `SELECT g.bot_user_id,COALESCE(NULLIF(b.display_name,''),b.username),b.username,
	g.messaging_enabled,g.revision,g.authorized_at,g.updated_at,g.revoked_at
	FROM application_game_grants g JOIN users b ON b.id=g.bot_user_id
	WHERE g.user_id=? AND b.is_bot=1 AND b.deleted_at IS NULL`

func scanApplicationGameGrant(row interface{ Scan(...any) error }) (*models.ApplicationGameGrant, error) {
	var out models.ApplicationGameGrant
	err := row.Scan(&out.ApplicationID, &out.ApplicationName, &out.ApplicationUsername, &out.MessagingEnabled, &out.Revision, &out.AuthorizedAt, &out.UpdatedAt, &out.RevokedAt)
	return &out, err
}

func (r *BotRepository) ListGameGrants(ctx context.Context, userID string) ([]models.ApplicationGameGrant, error) {
	rows, err := r.db.QueryContext(ctx, applicationGameGrantSelect+` ORDER BY g.authorized_at,g.bot_user_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]models.ApplicationGameGrant, 0)
	for rows.Next() {
		item, err := scanApplicationGameGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

// lockGameIdentity serializes grant changes and game sends on the same row.
// PostgreSQL takes a row write lock; SQLite's writer lock provides the same
// ordering. It must be called on the transaction that commits the operation.
func lockGameIdentity(ctx context.Context, db database.TxQuerier, botID string) (bool, error) {
	result, err := db.ExecContext(ctx, `UPDATE application_game_identities SET bot_user_id=bot_user_id WHERE bot_user_id=?`, botID)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (r *BotRepository) ChangeGameGrant(ctx context.Context, userID, botID string, expected int64, enabled, revoke bool) (*models.ApplicationGameGrant, error) {
	if expected < 0 || (revoke && expected == 0) {
		return nil, pkg.ErrBadRequest
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("game grant transaction unavailable")
	}
	var out *models.ApplicationGameGrant
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		registered, err := lockGameIdentity(ctx, tx, botID)
		if err != nil {
			return err
		}
		if !registered {
			return pkg.ErrNotFound
		}
		var eligible bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users a JOIN users b ON b.id=? WHERE a.id=?
			AND a.is_bot=0 AND a.deleted_at IS NULL AND b.is_bot=1 AND b.deleted_at IS NULL AND b.is_platform_banned=0)`, botID, userID).Scan(&eligible); err != nil {
			return err
		}
		if !eligible {
			return pkg.ErrNotFound
		}
		now := time.Now().UTC()
		if expected == 0 {
			result, err := tx.ExecContext(ctx, `INSERT INTO application_game_grants(user_id,bot_user_id,messaging_enabled,revision,authorized_at,updated_at)
				VALUES(?,?,?,1,?,?) ON CONFLICT(user_id,bot_user_id) DO NOTHING`, userID, botID, enabled, now, now)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return pkg.ErrConflict
			}
		} else {
			var revokedAt any
			if revoke {
				revokedAt = now
				enabled = false
			}
			result, err := tx.ExecContext(ctx, `UPDATE application_game_grants SET messaging_enabled=?,revision=revision+1,
				updated_at=?,revoked_at=? WHERE user_id=? AND bot_user_id=? AND revision=?`, enabled, now, revokedAt, userID, botID, expected)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return pkg.ErrConflict
			}
		}
		out, err = scanApplicationGameGrant(tx.QueryRowContext(ctx, applicationGameGrantSelect+` AND g.bot_user_id=?`, userID, botID))
		return err
	})
	return out, err
}

// authorizeGameMessage is shared by every persistent DM send path, including
// ordinary bot-token HTTP sends. Non-game bot behavior is deliberately unchanged.
// The identity lock remains held until the surrounding message transaction ends.
func (r *sqliteDMRepo) authorizeGameMessage(ctx context.Context, msg *models.DMMessage) error {
	msg.ApplicationID = nil
	var registered bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM application_game_identities WHERE bot_user_id=?)`, msg.UserID).Scan(&registered)
	if err != nil {
		return err
	}
	if !registered {
		return nil
	}
	if _, ok := r.db.(*sql.Tx); !ok {
		return fmt.Errorf("%w: game messages require a transaction", pkg.ErrForbidden)
	}
	// All game content/control writes lock channel before identity. Human
	// encryption toggles lock this same channel, and first-request transitions
	// already hold it; a consistent order prevents an identity/channel inversion.
	if _, err := r.db.ExecContext(ctx, `UPDATE dm_channels SET e2ee_enabled=e2ee_enabled WHERE id=?`, msg.DMChannelID); err != nil {
		return err
	}
	if registered, err = lockGameIdentity(ctx, r.db, msg.UserID); err != nil {
		return err
	} else if !registered {
		return pkg.ErrForbidden
	}
	var allowed bool
	err = r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM dm_channels c JOIN application_game_grants g
		ON g.bot_user_id=? AND g.user_id=CASE WHEN c.user1_id=? THEN c.user2_id ELSE c.user1_id END
		JOIN users recipient ON recipient.id=g.user_id JOIN users sender ON sender.id=g.bot_user_id
		WHERE c.id=? AND (c.user1_id=? OR c.user2_id=?) AND recipient.is_bot=0 AND recipient.deleted_at IS NULL
		AND sender.is_bot=1 AND sender.deleted_at IS NULL AND sender.is_platform_banned=0
		AND g.messaging_enabled=1 AND g.revoked_at IS NULL)`, msg.UserID, msg.UserID, msg.DMChannelID, msg.UserID, msg.UserID).Scan(&allowed)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if !allowed {
		return fmt.Errorf("%w: game messaging grant disabled or revoked", pkg.ErrForbidden)
	}
	applicationID := msg.UserID
	msg.ApplicationID = &applicationID
	return nil
}

func (r *sqliteDMRepo) requireGameEncryptedPayload(ctx context.Context, senderID, channelID string, version int, content, ciphertext *string, previous *models.DMMessage) error {
	var required bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM application_game_identities g JOIN dm_channels c ON c.id=? WHERE g.bot_user_id=? AND c.e2ee_enabled=1)`, channelID, senderID).Scan(&required)
	if err != nil {
		return err
	}
	if required && (version != 1 || (content != nil && *content != "") || ciphertext == nil || strings.TrimSpace(*ciphertext) == "") {
		return fmt.Errorf("%w: encrypted game conversations require ciphertext without plaintext content", pkg.ErrBadRequest)
	}
	// The existing edit API does not convert a stored message's encryption
	// format. Reject a purported encrypted edit of historical plaintext rather
	// than leaving the old content/version alongside a newly supplied cipher.
	if required && previous != nil && (previous.EncryptionVersion != 1 || (previous.Content != nil && *previous.Content != "")) {
		return fmt.Errorf("%w: historical plaintext game messages cannot be converted by an encrypted edit", pkg.ErrBadRequest)
	}
	return nil
}

// Content edits and attachment completion must not bypass a disabled grant by
// targeting an already stored message. Preserve its immutable origin marker;
// authorize against its stored sender, never a caller-supplied application ID.
func (r *sqliteDMRepo) withGameMessageMutation(ctx context.Context, messageID string, fn func(*sqliteDMRepo) error) error {
	return r.withGameActorMessageMutation(ctx, messageID, "", fn)
}

// actorID is explicit for reactions/pins: their actor need not be the original
// message author. An empty actor selects the stored author for content edits.
func (r *sqliteDMRepo) withGameActorMessageMutation(ctx context.Context, messageID, actorID string, fn func(*sqliteDMRepo) error) error {
	apply := func(txRepo *sqliteDMRepo) error {
		var stored models.DMMessage
		err := txRepo.db.QueryRowContext(ctx, `SELECT user_id,dm_channel_id FROM dm_messages WHERE id=?`, messageID).Scan(&stored.UserID, &stored.DMChannelID)
		if errors.Is(err, sql.ErrNoRows) {
			return pkg.ErrNotFound
		}
		if err != nil {
			return err
		}
		if actorID != "" {
			stored.UserID = actorID
		}
		if err := txRepo.authorizeGameMessage(ctx, &stored); err != nil {
			return err
		}
		return fn(txRepo)
	}
	if raw := database.RawDB(r.db); raw != nil {
		return database.WithTx(ctx, raw, func(tx *sql.Tx) error { return apply(&sqliteDMRepo{db: tx}) })
	}
	return apply(r)
}
