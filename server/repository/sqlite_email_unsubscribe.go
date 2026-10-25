package repository

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const emailUnsubscribeTokenLifetime = 30 * 24 * time.Hour

type sqliteEmailUnsubscribeRepo struct{ db database.TxQuerier }

func NewSQLiteEmailUnsubscribeRepo(db database.TxQuerier) EmailUnsubscribeRepository {
	return &sqliteEmailUnsubscribeRepo{db: db}
}

func validEmailUnsubscribeCategory(category string) bool {
	switch category {
	case models.EmailCategoryCommunication, models.EmailCategorySocial,
		models.EmailCategoryAnnouncements, models.EmailCategoryTips,
		models.EmailCategoryRecommendations:
		return true
	default:
		return false
	}
}

func parseEmailUnsubscribeToken(raw string) (string, error) {
	if len(raw) > 64 || strings.TrimSpace(raw) != raw {
		return "", ErrEmailUnsubscribeInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 {
		return "", ErrEmailUnsubscribeInvalid
	}
	return fmt.Sprintf("%x", sha256.Sum256(decoded)), nil
}

func (r *sqliteEmailUnsubscribeRepo) Issue(ctx context.Context, userID, category string, now time.Time) (string, error) {
	return r.issue(ctx, userID, category, "", now, false)
}

// IssueForAddress binds a token to the exact address captured by a queued
// email job. This prevents a worker from delivering an old job to a newly
// verified address after the account's email changes.
func (r *sqliteEmailUnsubscribeRepo) IssueForAddress(ctx context.Context, userID, category, expectedAddress string, now time.Time) (string, error) {
	if strings.TrimSpace(expectedAddress) == "" {
		return "", ErrEmailUnsubscribeIneligible
	}
	return r.issue(ctx, userID, category, expectedAddress, now, true)
}

func (r *sqliteEmailUnsubscribeRepo) issue(ctx context.Context, userID, category, expectedAddress string, now time.Time, requireAddressMatch bool) (string, error) {
	if r == nil || r.db == nil || strings.TrimSpace(userID) == "" || !validEmailUnsubscribeCategory(category) || now.IsZero() {
		return "", ErrEmailUnsubscribeIneligible
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(secret)
	hash := fmt.Sprintf("%x", sha256.Sum256(secret))
	nowUnix := now.UTC().Unix()
	expiresUnix := now.UTC().Add(emailUnsubscribeTokenLifetime).Unix()

	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return "", fmt.Errorf("email unsubscribe requires a transactional database")
	}
	err := database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		query := `SELECT email_generation,email FROM users WHERE id=? AND email IS NOT NULL AND email<>'' AND email_verified_at IS NOT NULL AND deleted_at IS NULL AND is_bot=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=users.id AND l.disabled_at IS NOT NULL)`
		if database.IsPostgres(r.db) {
			query += ` FOR UPDATE`
		}
		var generation int64
		var address string
		if err := tx.QueryRowContext(ctx, query, userID).Scan(&generation, &address); errors.Is(err, sql.ErrNoRows) {
			return ErrEmailUnsubscribeIneligible
		} else if err != nil {
			return err
		}
		if requireAddressMatch && address != expectedAddress {
			return ErrEmailUnsubscribeIneligible
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO email_unsubscribe_tokens(token_hash,user_id,category,email_generation,issued_at,expires_at) VALUES(?,?,?,?,?,?)`, hash, userID, category, generation, nowUnix, expiresUnix)
		return err
	})
	if err != nil {
		return "", err
	}
	return raw, nil
}

func (r *sqliteEmailUnsubscribeRepo) Inspect(ctx context.Context, raw string, now time.Time) (EmailUnsubscribeTokenState, error) {
	var state EmailUnsubscribeTokenState
	if r == nil || r.db == nil || now.IsZero() {
		return state, ErrEmailUnsubscribeInvalid
	}
	hash, err := parseEmailUnsubscribeToken(raw)
	if err != nil {
		return state, err
	}
	var generation, issued, expires int64
	var used sql.NullInt64
	var emailGeneration sql.NullInt64
	var verified sql.NullInt64
	err = r.db.QueryRowContext(ctx, `SELECT t.category,t.email_generation,t.issued_at,t.expires_at,t.used_at,u.email_generation,u.email_verified_at
		FROM email_unsubscribe_tokens t JOIN users u ON u.id=t.user_id
		WHERE t.token_hash=? AND u.email IS NOT NULL AND u.email<>'' AND u.deleted_at IS NULL AND u.is_bot=0
		AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, hash).
		Scan(&state.Category, &generation, &issued, &expires, &used, &emailGeneration, &verified)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (now.UTC().Unix() < issued || now.UTC().Unix() >= expires || !emailGeneration.Valid || emailGeneration.Int64 != generation || !verified.Valid) {
		return EmailUnsubscribeTokenState{}, ErrEmailUnsubscribeInvalid
	}
	if err != nil {
		return EmailUnsubscribeTokenState{}, err
	}
	if !validEmailUnsubscribeCategory(state.Category) {
		return EmailUnsubscribeTokenState{}, ErrEmailUnsubscribeInvalid
	}
	state.Consumed = used.Valid
	return state, nil
}

func (r *sqliteEmailUnsubscribeRepo) Consume(ctx context.Context, raw string, now time.Time) error {
	if r == nil || r.db == nil || now.IsZero() {
		return ErrEmailUnsubscribeInvalid
	}
	hash, err := parseEmailUnsubscribeToken(raw)
	if err != nil {
		return err
	}
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return fmt.Errorf("email unsubscribe requires a transactional database")
	}
	nowUnix := now.UTC().Unix()
	return database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		// Lock the account row before validating its generation. Besides
		// serializing concurrent consumes, this prevents an email change or
		// account anonymization from racing the generation check and opt-out.
		var userID string
		if err := tx.QueryRowContext(ctx, `SELECT user_id FROM email_unsubscribe_tokens WHERE token_hash=?`, hash).Scan(&userID); errors.Is(err, sql.ErrNoRows) {
			return ErrEmailUnsubscribeInvalid
		} else if err != nil {
			return err
		}
		locked, err := tx.ExecContext(ctx, `UPDATE users SET email_generation=email_generation WHERE id=?`, userID)
		if err != nil {
			return err
		}
		lockedRows, err := locked.RowsAffected()
		if err != nil {
			return err
		}
		if lockedRows != 1 {
			return ErrEmailUnsubscribeInvalid
		}
		query := `SELECT t.user_id,t.category,t.email_generation,t.issued_at,t.expires_at,t.used_at,u.email_generation,u.email_verified_at
			FROM email_unsubscribe_tokens t JOIN users u ON u.id=t.user_id
			WHERE t.token_hash=? AND u.email IS NOT NULL AND u.email<>'' AND u.deleted_at IS NULL AND u.is_bot=0
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`
		if database.IsPostgres(r.db) {
			query += ` FOR UPDATE OF t,u`
		}
		var category string
		var generation, issued, expires, currentGeneration int64
		var used, verified sql.NullInt64
		if err := tx.QueryRowContext(ctx, query, hash).Scan(&userID, &category, &generation, &issued, &expires, &used, &currentGeneration, &verified); errors.Is(err, sql.ErrNoRows) {
			return ErrEmailUnsubscribeInvalid
		} else if err != nil {
			return err
		}
		if !validEmailUnsubscribeCategory(category) || nowUnix < issued || nowUnix >= expires || !verified.Valid || currentGeneration != generation {
			return ErrEmailUnsubscribeInvalid
		}
		if used.Valid {
			return nil
		}

		if _, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}') ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
			return err
		}
		var update string
		var args []any
		if database.IsPostgres(r.db) {
			merged := `CASE WHEN jsonb_typeof(COALESCE(data::jsonb,'{}'::jsonb))='object' AND jsonb_typeof(COALESCE(data::jsonb->'email_preferences','{}'::jsonb))='object' THEN jsonb_set(COALESCE(data::jsonb,'{}'::jsonb),'{email_preferences}',COALESCE(data::jsonb->'email_preferences','{}'::jsonb) || jsonb_build_object(CAST(? AS text),FALSE),TRUE)::text ELSE NULL END`
			update = `UPDATE user_preferences SET data=` + merged + `,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND octet_length(` + merged + `)<=?`
			args = []any{category, userID, category, models.MaxPreferencesStoredBytes}
		} else {
			merged := `json_patch(CASE WHEN json_type(data)='object' AND (json_type(data,'$.email_preferences') IS NULL OR json_type(data,'$.email_preferences')='object') THEN data ELSE json('invalid stored preferences') END,json_object('email_preferences',json_object(?,json('false'))))`
			update = `UPDATE user_preferences SET data=` + merged + `,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND length(CAST(` + merged + ` AS BLOB))<=?`
			args = []any{category, userID, category, models.MaxPreferencesStoredBytes}
		}
		result, err := tx.ExecContext(ctx, update, args...)
		if err != nil {
			return fmt.Errorf("update email preferences: %w", err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return fmt.Errorf("email preference update exceeded storage limit")
		}

		result, err = tx.ExecContext(ctx, `UPDATE email_unsubscribe_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND email_generation=?`, nowUnix, hash, nowUnix, generation)
		if err != nil {
			return err
		}
		changed, err = result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 1 {
			return nil
		}
		// A concurrent request may have consumed the same token. The operation
		// is idempotent only when the still-valid row is now marked used.
		var consumed bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM email_unsubscribe_tokens WHERE token_hash=? AND used_at IS NOT NULL AND expires_at>? AND email_generation=?)`, hash, nowUnix, generation).Scan(&consumed); err != nil {
			return err
		}
		if !consumed {
			return ErrEmailUnsubscribeInvalid
		}
		return nil
	})
}
