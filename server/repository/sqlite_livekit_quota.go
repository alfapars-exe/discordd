package repository

// Quota tracking: monthly usage accounting, quota-aware instance listing,
// auto-switch selection, and partial quota-settings updates.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// IncrementMonthlyUsage adds `seconds` to (instance, year, month). Idempotent
// across crashes — duplicate calls only inflate the row, never duplicate it.
// Skipped silently when seconds <= 0 so cleanup paths can call it on every
// session-end without checking duration first.
func (r *sqliteLiveKitRepo) IncrementMonthlyUsage(
	ctx context.Context, instanceID string, year, month, seconds int,
) error {
	if seconds <= 0 {
		return nil
	}
	query := `
		INSERT INTO livekit_monthly_usage (instance_id, year, month, used_seconds)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(instance_id, year, month)
		DO UPDATE SET used_seconds = used_seconds + excluded.used_seconds`
	if _, err := r.db.ExecContext(ctx, query, instanceID, year, month, seconds); err != nil {
		return fmt.Errorf("failed to increment monthly usage: %w", err)
	}
	return nil
}

// GetMonthlyUsage returns the accumulated session-seconds for one instance
// in one calendar month. Missing row → 0 (no error).
func (r *sqliteLiveKitRepo) GetMonthlyUsage(
	ctx context.Context, instanceID string, year, month int,
) (int64, error) {
	var used int64
	err := r.db.QueryRowContext(ctx,
		`SELECT used_seconds FROM livekit_monthly_usage
		 WHERE instance_id = ? AND year = ? AND month = ?`,
		instanceID, year, month,
	).Scan(&used)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("failed to get monthly usage: %w", err)
	}
	return used, nil
}

// ListInstancesWithQuota returns every instance (cloud + self-hosted) and a
// parallel slice of current-month used_seconds. Self-hosted entries always
// get 0 — caller filters quota math by IsPlatformManaged.
func (r *sqliteLiveKitRepo) ListInstancesWithQuota(
	ctx context.Context, year, month int,
) ([]models.LiveKitInstance, []int64, error) {
	query := `
		SELECT ` + instanceColumns + `,
		       COALESCE(u.used_seconds, 0) AS used_seconds
		FROM livekit_instances
		LEFT JOIN livekit_monthly_usage u
		  ON u.instance_id = livekit_instances.id
		  AND u.year = ?
		  AND u.month = ?
		ORDER BY priority ASC, created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, year, month)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to list instances with quota: %w", err)
	}
	defer rows.Close()

	var instances []models.LiveKitInstance
	var usedSeconds []int64
	for rows.Next() {
		var inst models.LiveKitInstance
		var used int64
		// Reuse scanInstance for the instance columns, then peel off the
		// trailing used_seconds. Slightly awkward — Scan needs a flat list
		// — but it keeps the canonical column list authoritative.
		err := rows.Scan(
			&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
			&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers,
			&inst.HetznerServerID, &inst.CreatedAt,
			&inst.Priority, &inst.MonthlyQuotaMinutes, &inst.QuotaResetDay,
			&inst.AutoSwitchEnabled, &inst.SwitchThresholdMinutes,
			&used,
		)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to scan instance with quota: %w", err)
		}
		// Self-hosted instances aren't tracked — surface 0 explicitly so the
		// caller doesn't have to second-guess stale rows from a previous run.
		if !inst.IsPlatformManaged {
			used = 0
		}
		instances = append(instances, inst)
		usedSeconds = append(usedSeconds, used)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("error iterating instances with quota: %w", err)
	}
	return instances, usedSeconds, nil
}

// GetNextAutoSwitchInstance picks the next eligible cloud instance to take
// over for the given currentID. Eligibility: is_platform_managed=1, auto_switch_enabled=1,
// id != currentID, AND (used_seconds + threshold*60) < quota*60. Among those,
// lowest priority wins, ties broken by lowest server_count.
//
// Returns nil + nil when nothing fits — caller stays on the current instance
// (best-effort: dropped calls are better than failing the join entirely).
func (r *sqliteLiveKitRepo) GetNextAutoSwitchInstance(
	ctx context.Context, currentID string, year, month int,
) (*models.LiveKitInstance, error) {
	query := `
		SELECT ` + instanceColumns + `
		FROM livekit_instances
		LEFT JOIN livekit_monthly_usage u
		  ON u.instance_id = livekit_instances.id
		  AND u.year = ?
		  AND u.month = ?
		WHERE livekit_instances.id != ?
		  AND livekit_instances.is_platform_managed = 1
		  AND livekit_instances.auto_switch_enabled = 1
		  AND (
		    (monthly_quota_minutes - switch_threshold_minutes) * 60
		    > COALESCE(u.used_seconds, 0)
		  )
		  AND (
		    livekit_instances.max_servers = 0
		    OR (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) < livekit_instances.max_servers
		  )
		ORDER BY priority ASC, server_count ASC
		LIMIT 1`

	inst := &models.LiveKitInstance{}
	err := scanInstance(r.db.QueryRowContext(ctx, query, year, month, currentID), inst)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get next auto-switch instance: %w", err)
	}
	return inst, nil
}

// UpdateQuotaSettings applies a partial update of the quota columns. Builds
// the SET clause dynamically to skip nil pointers — keeps the credential
// columns out of reach from this endpoint entirely.
func (r *sqliteLiveKitRepo) UpdateQuotaSettings(
	ctx context.Context, instanceID string, settings *models.UpdateLiveKitQuotaSettingsRequest,
) error {
	if settings == nil {
		return nil
	}
	sets := []string{}
	args := []any{}
	if settings.Priority != nil {
		sets = append(sets, "priority = ?")
		args = append(args, *settings.Priority)
	}
	if settings.MonthlyQuotaMinutes != nil {
		sets = append(sets, "monthly_quota_minutes = ?")
		args = append(args, *settings.MonthlyQuotaMinutes)
	}
	if settings.QuotaResetDay != nil {
		sets = append(sets, "quota_reset_day = ?")
		args = append(args, *settings.QuotaResetDay)
	}
	if settings.AutoSwitchEnabled != nil {
		sets = append(sets, "auto_switch_enabled = ?")
		args = append(args, *settings.AutoSwitchEnabled)
	}
	if settings.SwitchThresholdMinutes != nil {
		sets = append(sets, "switch_threshold_minutes = ?")
		args = append(args, *settings.SwitchThresholdMinutes)
	}
	if len(sets) == 0 {
		// Nothing to update; treat as success (matches PATCH semantics).
		return nil
	}
	args = append(args, instanceID)

	query := "UPDATE livekit_instances SET " + sets[0]
	for i := 1; i < len(sets); i++ {
		query += ", " + sets[i]
	}
	query += " WHERE id = ?"

	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to update quota settings: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
