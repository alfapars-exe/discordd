package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// BotRepository persists bot accounts (rows in users with is_bot=1) and their
// long-lived bearer tokens (bot_tokens, stored only as a SHA-256 hash). IDs are
// generated SQLite-side via lower(hex(randomblob(..))) to match the convention
// used by the human user repo (sqlite_user.go Create).
type BotRepository struct{ db database.TxQuerier }

func NewBotRepository(db database.TxQuerier) *BotRepository { return &BotRepository{db: db} }

// CreateBotWithToken creates the automation identity and its first credential
// in one transaction. A token persistence failure must not strand an
// owner-linked bot that cannot authenticate or be recovered from the one-time
// plaintext credential response.
func (r *BotRepository) CreateBotWithToken(ctx context.Context, username, displayName, ownerID, hash string) (string, error) {
	botID, err := generateID()
	if err != nil {
		return "", err
	}
	tokenID, err := generateIDN(16)
	if err != nil {
		return "", err
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return "", fmt.Errorf("create bot transaction unavailable")
	}
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if _, execErr := tx.ExecContext(ctx,
			`INSERT INTO users (id, username, display_name, password_hash, status, language, is_bot, owner_user_id)
			 VALUES (?, ?, ?, '!disabled!', 'online', 'en', 1, ?)`,
			botID, username, displayName, ownerID); execErr != nil {
			return execErr
		}
		_, execErr := tx.ExecContext(ctx,
			`INSERT INTO bot_tokens (id, bot_user_id, token_hash, name) VALUES (?, ?, ?, NULL)`,
			tokenID, botID, hash)
		return execErr
	})
	if err != nil {
		return "", err
	}
	return botID, nil
}

// InsertBotUser creates the users row backing a bot (disabled password) and
// returns the SQLite-generated id. owner_user_id has a FK to users(id), so the
// owner row must already exist.
func (r *BotRepository) InsertBotUser(ctx context.Context, username, displayName, ownerID string) (string, error) {
	id, err := generateID()
	if err != nil {
		return "", err
	}
	_, err = r.db.ExecContext(ctx,
		`INSERT INTO users (id, username, display_name, password_hash, status, language, is_bot, owner_user_id)
		 VALUES (?, ?, ?, '!disabled!', 'online', 'en', 1, ?)`,
		id, username, displayName, ownerID)
	return id, err
}

// InsertToken stores a bot token by its hash and returns the generated token id.
// bot_tokens.id is a TEXT PRIMARY KEY with no default, so it is generated here.
func (r *BotRepository) InsertToken(ctx context.Context, botUserID, hash string, name *string) (string, error) {
	// 16 bytes (32 hex chars) to match the previous lower(hex(randomblob(16))).
	id, err := generateIDN(16)
	if err != nil {
		return "", err
	}
	_, err = r.db.ExecContext(ctx,
		`INSERT INTO bot_tokens (id, bot_user_id, token_hash, name)
		 VALUES (?, ?, ?, ?)`,
		id, botUserID, hash, name)
	return id, err
}

// BotUserIDByTokenHash returns the bot user id for a live (non-revoked) token
// and stamps last_used_at. Returns sql.ErrNoRows if absent or revoked.
func (r *BotRepository) BotUserIDByTokenHash(ctx context.Context, hash string) (string, error) {
	var botUserID string
	err := r.db.QueryRowContext(ctx,
		`SELECT t.bot_user_id FROM bot_tokens t JOIN users b ON b.id=t.bot_user_id
		 WHERE t.token_hash=? AND t.revoked_at IS NULL AND b.is_bot=1 AND b.deleted_at IS NULL AND b.is_platform_banned=0
		 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=b.id AND l.disabled_at IS NOT NULL)`,
		hash).Scan(&botUserID)
	if err != nil {
		return "", err
	}
	_, _ = r.db.ExecContext(ctx,
		`UPDATE bot_tokens SET last_used_at = ? WHERE token_hash = ?`, time.Now().UTC(), hash)
	return botUserID, nil
}

// ListByOwner returns every bot owned by the given human.
func (r *BotRepository) ListByOwner(ctx context.Context, ownerID string) ([]models.User, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, username, display_name, created_at
		 FROM users WHERE owner_user_id = ? AND is_bot = 1
		 ORDER BY created_at`, ownerID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }() // read-side handle — nothing buffered to flush, safe to ignore

	var out []models.User
	for rows.Next() {
		u := models.User{IsBot: true, OwnerUserID: &ownerID}
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// RevokeAllForBot revokes every live token only after proving current
// ownership in the same transaction. The boolean distinguishes an owned bot
// that already has no live tokens (idempotent success) from a foreign/missing
// target (not found); RowsAffected alone cannot make that distinction.
func (r *BotRepository) RevokeAllForBot(ctx context.Context, ownerID, botID string) (bool, error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, fmt.Errorf("revoke bot transaction unavailable")
	}
	owned := false
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// The harmless write obtains SQLite's writer boundary before checking
		// ownership, so retirement cannot detach the bot between this proof and
		// the credential update.
		result, execErr := tx.ExecContext(ctx,
			`UPDATE users SET status=status WHERE id=? AND owner_user_id=? AND is_bot=1
			 AND deleted_at IS NULL AND is_platform_admin=0`, botID, ownerID)
		if execErr != nil {
			return execErr
		}
		rows, execErr := result.RowsAffected()
		if execErr != nil {
			return execErr
		}
		if rows != 1 {
			return nil
		}
		owned = true
		_, execErr = tx.ExecContext(ctx,
			`UPDATE bot_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL AND bot_user_id = ?`, botID)
		return execErr
	})
	return owned, err
}

func (r *BotRepository) CreateTransferRequest(ctx context.Context, ownerID, botID, recipientUsername string, expiresAt time.Time) (*models.ApplicationTransferRequest, error) {
	id, err := generateIDN(16)
	if err != nil {
		return nil, err
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("application transfer transaction unavailable")
	}
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		var recipientID string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE lower(username)=lower(?) AND is_bot=0 AND deleted_at IS NULL AND id<>?`, recipientUsername, ownerID).Scan(&recipientID); err != nil {
			return err
		}
		// Expired requests must not permanently occupy the one-pending slot.
		if _, err := tx.ExecContext(ctx, `DELETE FROM application_transfer_requests WHERE bot_user_id=? AND expires_at<=CURRENT_TIMESTAMP`, botID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO application_transfer_requests(id,bot_user_id,from_user_id,to_user_id,expires_at)
			SELECT ?,id,owner_user_id,?,? FROM users WHERE id=? AND owner_user_id=? AND is_bot=1 AND deleted_at IS NULL`, id, recipientID, expiresAt.UTC(), botID, ownerID)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return pkg.ErrNotFound
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	request, err := r.TransferRequestByID(ctx, id)
	if err != nil {
		return nil, err
	}
	return request, nil
}

func (r *BotRepository) TransferRequestByID(ctx context.Context, id string) (*models.ApplicationTransferRequest, error) {
	var out models.ApplicationTransferRequest
	err := r.db.QueryRowContext(ctx, `SELECT tr.id,tr.bot_user_id,b.username,COALESCE(NULLIF(b.display_name,''),b.username),
		tr.from_user_id,COALESCE(NULLIF(sender.display_name,''),sender.username),tr.to_user_id,tr.created_at,tr.expires_at
		FROM application_transfer_requests tr JOIN users b ON b.id=tr.bot_user_id JOIN users sender ON sender.id=tr.from_user_id WHERE tr.id=?`, id).
		Scan(&out.ID, &out.BotUserID, &out.BotUsername, &out.BotName, &out.FromUserID, &out.FromName, &out.ToUserID, &out.CreatedAt, &out.ExpiresAt)
	return &out, err
}

func (r *BotRepository) ListIncomingTransfers(ctx context.Context, recipientID string, now time.Time) ([]models.ApplicationTransferRequest, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT tr.id,tr.bot_user_id,b.username,COALESCE(NULLIF(b.display_name,''),b.username),
		tr.from_user_id,COALESCE(NULLIF(sender.display_name,''),sender.username),tr.to_user_id,tr.created_at,tr.expires_at
		FROM application_transfer_requests tr JOIN users b ON b.id=tr.bot_user_id JOIN users sender ON sender.id=tr.from_user_id
		WHERE tr.to_user_id=? AND tr.expires_at>? ORDER BY tr.created_at`, recipientID, now.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.ApplicationTransferRequest
	for rows.Next() {
		var item models.ApplicationTransferRequest
		if err := rows.Scan(&item.ID, &item.BotUserID, &item.BotUsername, &item.BotName, &item.FromUserID, &item.FromName, &item.ToUserID, &item.CreatedAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *BotRepository) ResolveTransfer(ctx context.Context, recipientID, requestID, newTokenHash string, accept bool, now time.Time) (string, error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return "", fmt.Errorf("application transfer transaction unavailable")
	}
	var botID string
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		var fromID string
		var expires time.Time
		if err := tx.QueryRowContext(ctx, `SELECT bot_user_id,from_user_id,expires_at FROM application_transfer_requests WHERE id=? AND to_user_id=?`, requestID, recipientID).Scan(&botID, &fromID, &expires); err != nil {
			return err
		}
		if !expires.After(now) {
			return pkg.ErrNotFound
		}
		if !accept {
			_, err := tx.ExecContext(ctx, `DELETE FROM application_transfer_requests WHERE id=?`, requestID)
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE users SET owner_user_id=? WHERE id=? AND owner_user_id=? AND is_bot=1 AND deleted_at IS NULL`, recipientID, botID, fromID)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return pkg.ErrNotFound
		}
		if _, err = tx.ExecContext(ctx, `UPDATE bot_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE bot_user_id=? AND revoked_at IS NULL`, botID); err != nil {
			return err
		}
		tokenID, err := generateIDN(16)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO bot_tokens(id,bot_user_id,token_hash,name) VALUES(?,?,?,'ownership transfer')`, tokenID, botID, newTokenHash); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM application_transfer_requests WHERE bot_user_id=?`, botID)
		return err
	})
	return botID, err
}
