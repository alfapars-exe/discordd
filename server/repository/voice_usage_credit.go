package repository

import (
	"context"
	"database/sql"
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

func (r *sqliteLiveKitRepo) RecordVoiceUsage(ctx context.Context, id, instance string, year, month, seconds int) error {
	if id == "" || instance == "" || year < 1 || month < 1 || month > 12 || seconds <= 0 {
		return pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("voice usage credit requires a transaction-capable pool")
	}
	return database.WithTx(ctx, db, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `INSERT INTO voice_usage_credits(credit_id,instance_id,year,month,seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(credit_id) DO NOTHING`, id, instance, year, month, seconds)
		if err != nil {
			return fmt.Errorf("record usage identity: %w", err)
		}
		inserted, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if inserted == 0 {
			var storedInstance string
			var storedYear, storedMonth, storedSeconds int
			if err = tx.QueryRowContext(ctx, `SELECT instance_id,year,month,seconds FROM voice_usage_credits WHERE credit_id=$1`, id).Scan(&storedInstance, &storedYear, &storedMonth, &storedSeconds); err != nil {
				return err
			}
			if storedInstance != instance || storedYear != year || storedMonth != month || storedSeconds != seconds {
				return pkg.ErrConflict
			}
			return nil
		}
		const applyCredit = `INSERT INTO livekit_monthly_usage(instance_id,year,month,used_seconds)
 VALUES($1,$2,$3,$4) ON CONFLICT(instance_id,year,month)
 DO UPDATE SET used_seconds=livekit_monthly_usage.used_seconds+excluded.used_seconds`
		_, err = tx.ExecContext(ctx, applyCredit, instance, year, month, seconds)
		if err != nil {
			return fmt.Errorf("apply usage credit: %w", err)
		}
		return nil
	})
}
