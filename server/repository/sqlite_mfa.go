package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteMFARepo struct{ db database.TxQuerier }

func NewSQLiteMFARepo(db database.TxQuerier) MFARepository { return &sqliteMFARepo{db: db} }

func (r *sqliteMFARepo) Get(ctx context.Context, userID string) (*models.MFARecord, error) {
	var record models.MFARecord
	err := r.db.QueryRowContext(ctx, `SELECT COALESCE(secret,''), COALESCE(pending_secret,''), COALESCE(pending_id,''), pending_expires, last_step, json_array_length(recovery_hashes), recovery_version FROM account_mfa WHERE user_id=?`, userID).Scan(&record.Secret, &record.PendingSecret, &record.PendingID, &record.PendingExpires, &record.LastStep, &record.RecoveryRemaining, &record.RecoveryVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return &record, nil
	}
	return &record, err
}

func (r *sqliteMFARepo) update(ctx context.Context, query string, args ...any) (bool, error) {
	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (r *sqliteMFARepo) ReserveAttempt(ctx context.Context, userID string, now int64) (bool, error) {
	if _, err := r.db.ExecContext(ctx, `INSERT INTO account_mfa(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
		return false, err
	}
	return r.update(ctx, `UPDATE account_mfa SET attempt_count=CASE WHEN attempt_window<=? THEN 1 ELSE attempt_count+1 END, attempt_window=CASE WHEN attempt_window<=? THEN ? ELSE attempt_window END WHERE user_id=? AND (attempt_window<=? OR attempt_count<5)`, now-300, now-300, now, userID, now-300)
}

func (r *sqliteMFARepo) Prepare(ctx context.Context, userID, encrypted, setupID string, expires int64) (bool, error) {
	return r.update(ctx, `UPDATE account_mfa SET pending_secret=?, pending_id=?, pending_expires=? WHERE user_id=? AND secret IS NULL`, encrypted, setupID, expires, userID)
}

func (r *sqliteMFARepo) CancelSetup(ctx context.Context, userID, setupID string) (bool, error) {
	return r.update(ctx, `UPDATE account_mfa SET pending_secret=NULL,pending_id=NULL,pending_expires=0 WHERE user_id=? AND pending_id=? AND secret IS NULL`, userID, setupID)
}

func (r *sqliteMFARepo) Enable(ctx context.Context, userID, setupID string, now, step int64, hashes []string) (bool, error) {
	encoded, err := json.Marshal(hashes)
	if err != nil {
		return false, err
	}
	return r.update(ctx, `UPDATE account_mfa SET secret=pending_secret, pending_secret=NULL, pending_id=NULL, pending_expires=0, last_step=?, recovery_hashes=?, recovery_version=recovery_version+1 WHERE user_id=? AND secret IS NULL AND pending_id=? AND pending_secret IS NOT NULL AND pending_expires>?`, step, string(encoded), userID, setupID, now)
}

func (r *sqliteMFARepo) ConsumeTOTP(ctx context.Context, userID, secret string, step int64) (bool, error) {
	return r.update(ctx, `UPDATE account_mfa SET last_step=? WHERE user_id=? AND secret=? AND last_step<?`, step, userID, secret, step)
}

func (r *sqliteMFARepo) ConsumeRecovery(ctx context.Context, userID, secret, hash string) (bool, error) {
	if database.IsPostgres(r.db) {
		// UPDATE locks and rechecks the current row after a concurrent writer;
		// the array index and existence predicate use that same row version.
		return r.update(ctx, `UPDATE account_mfa SET recovery_hashes=(recovery_hashes::jsonb -
		 (SELECT (ordinality-1)::integer FROM jsonb_array_elements_text(recovery_hashes::jsonb) WITH ORDINALITY
		  WHERE value=? LIMIT 1))::text
		 WHERE user_id=? AND secret=? AND recovery_hashes::jsonb @> jsonb_build_array(?::text)`, hash, userID, secret, hash)
	}
	// The lookup, removal and enabled-secret/version check form ONE atomic
	// statement. Two workers cannot both spend the same recovery code.
	return r.update(ctx, `UPDATE account_mfa SET recovery_hashes=json_remove(recovery_hashes,(SELECT fullkey FROM json_each(recovery_hashes) WHERE value=? LIMIT 1)) WHERE user_id=? AND secret=? AND EXISTS(SELECT 1 FROM json_each(recovery_hashes) WHERE value=?)`, hash, userID, secret, hash)
}

func (r *sqliteMFARepo) ReplaceRecovery(ctx context.Context, userID, secret string, version int64, hashes []string) (bool, error) {
	encoded, err := json.Marshal(hashes)
	if err != nil {
		return false, err
	}
	return r.update(ctx, `UPDATE account_mfa SET recovery_hashes=?, recovery_version=recovery_version+1 WHERE user_id=? AND secret=? AND recovery_version=?`, string(encoded), userID, secret, version)
}

func (r *sqliteMFARepo) Disable(ctx context.Context, userID, secret string) (bool, error) {
	return r.update(ctx, `UPDATE account_mfa SET secret=NULL, pending_secret=NULL, pending_id=NULL, pending_expires=0, last_step=-1, recovery_hashes='[]' WHERE user_id=? AND secret=?`, userID, secret)
}
