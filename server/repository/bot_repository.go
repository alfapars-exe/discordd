package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// BotRepository persists bot accounts (rows in users with is_bot=1) and their
// long-lived bearer tokens (bot_tokens, stored only as a SHA-256 hash). IDs are
// generated SQLite-side via lower(hex(randomblob(..))) to match the convention
// used by the human user repo (sqlite_user.go Create).
type BotRepository struct{ db database.TxQuerier }

func NewBotRepository(db database.TxQuerier) *BotRepository { return &BotRepository{db: db} }

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
		`SELECT bot_user_id FROM bot_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
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
	defer rows.Close()

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

// RevokeAllForBot revokes every live token of one bot, but only when that bot is
// owned by ownerID — preventing one owner from disabling another's bot.
func (r *BotRepository) RevokeAllForBot(ctx context.Context, ownerID, botID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE bot_tokens SET revoked_at = CURRENT_TIMESTAMP
		 WHERE revoked_at IS NULL AND bot_user_id = ?
		   AND bot_user_id IN (SELECT id FROM users WHERE owner_user_id = ? AND is_bot = 1)`,
		botID, ownerID)
	return err
}
