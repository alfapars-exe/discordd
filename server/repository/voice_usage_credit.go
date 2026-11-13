package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// VoiceUsageRecorder commits a stable credit identity and aggregate together.
// Matching replays succeed without adding again; conflicting payloads fail.
// It requires a pool-backed repository, since it owns the transaction boundary.
type VoiceUsageRecorder interface {
	RecordVoiceUsage(context.Context, string, string, int, int, int) error
}

// VoiceUsageQueue persists pending credits separately from their application.
// An accepted enqueue can be recovered by another repository/process instance.
type VoiceUsageQueue interface {
	EnqueueVoiceUsage(context.Context, string, string, int, int, int) error
	ApplyNextVoiceUsage(context.Context) (bool, error)
}

func (r *sqliteLiveKitRepo) RecordVoiceUsage(ctx context.Context, id, instance string, year, month, seconds int) error {
	return r.storeVoiceUsage(ctx, id, instance, year, month, seconds, true)
}
func (r *sqliteLiveKitRepo) EnqueueVoiceUsage(ctx context.Context, id, instance string, year, month, seconds int) error {
	return r.storeVoiceUsage(ctx, id, instance, year, month, seconds, false)
}
func (r *sqliteLiveKitRepo) storeVoiceUsage(ctx context.Context, id, instance string, year, month, seconds int, apply bool) error {
	if id == "" || instance == "" || year < 1 || month < 1 || month > 12 || seconds <= 0 {
		return pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("voice usage credit requires a transaction-capable pool")
	}
	return database.WithTx(ctx, db, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO voice_usage_credits(credit_id,instance_id,year,month,seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(credit_id) DO NOTHING`, id, instance, year, month, seconds); err != nil {
			return fmt.Errorf("record usage identity: %w", err)
		}
		var storedInstance string
		var storedYear, storedMonth, storedSeconds int
		var applied bool
		if err := tx.QueryRowContext(ctx, `SELECT instance_id,year,month,seconds,applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id=$1 FOR UPDATE`, id).Scan(&storedInstance, &storedYear, &storedMonth, &storedSeconds, &applied); err != nil {
			return err
		}
		if storedInstance != instance || storedYear != year || storedMonth != month || storedSeconds != seconds {
			return pkg.ErrConflict
		}
		if !apply || applied {
			return nil
		}
		return applyVoiceUsageCredit(ctx, tx, id, instance, year, month, seconds)
	})
}

func applyVoiceUsageCredit(ctx context.Context, tx *sql.Tx, id, instance string, year, month, seconds int) error {
	const aggregate = `INSERT INTO livekit_monthly_usage(instance_id,year,month,used_seconds)
 VALUES($1,$2,$3,$4) ON CONFLICT(instance_id,year,month)
 DO UPDATE SET used_seconds=livekit_monthly_usage.used_seconds+excluded.used_seconds`
	if _, err := tx.ExecContext(ctx, aggregate, instance, year, month, seconds); err != nil {
		return fmt.Errorf("apply usage credit: %w", err)
	}
	_, err := tx.ExecContext(ctx, `UPDATE voice_usage_credits SET applied_at=CURRENT_TIMESTAMP WHERE credit_id=$1`, id)
	return err
}

func (r *sqliteLiveKitRepo) ApplyNextVoiceUsage(ctx context.Context) (bool, error) {
	db := database.RawDB(r.db)
	if db == nil {
		return false, fmt.Errorf("voice usage credit requires a transaction-capable pool")
	}
	applied := false
	err := database.WithTx(ctx, db, func(tx *sql.Tx) error {
		var id, instance string
		var year, month, seconds int
		err := tx.QueryRowContext(ctx, `SELECT credit_id,instance_id,year,month,seconds FROM voice_usage_credits WHERE applied_at IS NULL ORDER BY created_at,credit_id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&id, &instance, &year, &month, &seconds)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if err = applyVoiceUsageCredit(ctx, tx, id, instance, year, month, seconds); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied && err == nil, err
}
