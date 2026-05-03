package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteLiveKitRepo struct {
	db database.TxQuerier
}

func NewSQLiteLiveKitRepo(db database.TxQuerier) LiveKitRepository {
	return &sqliteLiveKitRepo{db: db}
}

// instanceColumns is the canonical SELECT column list for a livekit_instance
// row. Centralised here so adding a new column is a one-line change instead
// of edits to every SELECT in this file. server_count is computed from the
// servers table for accuracy (denormalised counter can drift on bugs).
//
// All columns are qualified with `livekit_instances.` so this list works
// under JOINs against `servers` and `livekit_monthly_usage` — multiple
// columns (id, created_at, ...) overlap by name across those tables.
const instanceColumns = `
	livekit_instances.id, livekit_instances.url, livekit_instances.api_key, livekit_instances.api_secret, livekit_instances.is_platform_managed,
	(SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS server_count,
	livekit_instances.max_servers, livekit_instances.hetzner_server_id, livekit_instances.created_at,
	livekit_instances.priority, livekit_instances.monthly_quota_minutes, livekit_instances.quota_reset_day, livekit_instances.auto_switch_enabled, livekit_instances.switch_threshold_minutes`

// rowScanner abstracts *sql.Row vs *sql.Rows so scanInstance works for both.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanInstance reads one row in the order produced by `instanceColumns`.
// Used by every SELECT here so adding a field is a two-line change
// (instanceColumns + this function).
func scanInstance(row rowScanner, inst *models.LiveKitInstance) error {
	return row.Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers,
		&inst.HetznerServerID, &inst.CreatedAt,
		&inst.Priority, &inst.MonthlyQuotaMinutes, &inst.QuotaResetDay,
		&inst.AutoSwitchEnabled, &inst.SwitchThresholdMinutes,
	)
}

func (r *sqliteLiveKitRepo) Create(ctx context.Context, instance *models.LiveKitInstance) error {
	// Generate ID in Go rather than relying on RETURNING for safer cross-driver compat.
	var generatedID string
	if err := r.db.QueryRowContext(ctx,
		`SELECT lower(hex(randomblob(8)))`,
	).Scan(&generatedID); err != nil {
		return fmt.Errorf("failed to generate livekit instance id: %w", err)
	}

	// Apply sane defaults so callers that only fill the credential fields
	// (the existing PlatformSettings flow) still get a valid quota row.
	if instance.MonthlyQuotaMinutes == 0 {
		instance.MonthlyQuotaMinutes = 5000 // LiveKit Cloud free tier default
	}
	if instance.QuotaResetDay == 0 {
		instance.QuotaResetDay = 1
	}
	if instance.SwitchThresholdMinutes == 0 {
		instance.SwitchThresholdMinutes = 20
	}
	if instance.Priority == 0 {
		instance.Priority = 100
	}

	query := `
		INSERT INTO livekit_instances (
			id, url, api_key, api_secret, is_platform_managed,
			server_count, max_servers, hetzner_server_id,
			priority, monthly_quota_minutes, quota_reset_day,
			auto_switch_enabled, switch_threshold_minutes
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		generatedID, instance.URL, instance.APIKey, instance.APISecret,
		instance.IsPlatformManaged, instance.ServerCount, instance.MaxServers, instance.HetznerServerID,
		instance.Priority, instance.MonthlyQuotaMinutes, instance.QuotaResetDay,
		instance.AutoSwitchEnabled, instance.SwitchThresholdMinutes,
	)
	if err != nil {
		return fmt.Errorf("failed to create livekit instance: %w", err)
	}

	// Read back created_at (DB default)
	instance.ID = generatedID
	return r.db.QueryRowContext(ctx,
		`SELECT created_at FROM livekit_instances WHERE id = ?`, generatedID,
	).Scan(&instance.CreatedAt)
}

func (r *sqliteLiveKitRepo) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	query := `SELECT ` + instanceColumns + ` FROM livekit_instances WHERE id = ?`

	inst := &models.LiveKitInstance{}
	err := scanInstance(r.db.QueryRowContext(ctx, query, id), inst)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance: %w", err)
	}

	return inst, nil
}

func (r *sqliteLiveKitRepo) GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	query := `
		SELECT ` + instanceColumns + `
		FROM livekit_instances
		INNER JOIN servers s ON s.livekit_instance_id = livekit_instances.id
		WHERE s.id = ?`

	inst := &models.LiveKitInstance{}
	err := scanInstance(r.db.QueryRowContext(ctx, query, serverID), inst)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance by server: %w", err)
	}

	return inst, nil
}

// GetLeastLoadedPlatformInstance returns the platform-managed instance with fewest servers
// that still has capacity. max_servers = 0 means unlimited.
func (r *sqliteLiveKitRepo) GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error) {
	query := `
		SELECT ` + instanceColumns + `
		FROM livekit_instances
		WHERE is_platform_managed = 1
		  AND (max_servers = 0 OR (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) < max_servers)
		ORDER BY server_count ASC
		LIMIT 1`

	inst := &models.LiveKitInstance{}
	err := scanInstance(r.db.QueryRowContext(ctx, query), inst)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get least loaded platform instance: %w", err)
	}

	return inst, nil
}

func (r *sqliteLiveKitRepo) IncrementServerCount(ctx context.Context, instanceID string) error {
	query := `UPDATE livekit_instances SET server_count = server_count + 1 WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, instanceID)
	if err != nil {
		return fmt.Errorf("failed to increment server count: %w", err)
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

func (r *sqliteLiveKitRepo) DecrementServerCount(ctx context.Context, instanceID string) error {
	query := `UPDATE livekit_instances SET server_count = MAX(server_count - 1, 0) WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, instanceID)
	if err != nil {
		return fmt.Errorf("failed to decrement server count: %w", err)
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

func (r *sqliteLiveKitRepo) Update(ctx context.Context, instance *models.LiveKitInstance) error {
	query := `
		UPDATE livekit_instances SET
			url = ?, api_key = ?, api_secret = ?,
			max_servers = ?, hetzner_server_id = ?, is_platform_managed = ?,
			priority = ?, monthly_quota_minutes = ?, quota_reset_day = ?,
			auto_switch_enabled = ?, switch_threshold_minutes = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret,
		instance.MaxServers, instance.HetznerServerID, instance.IsPlatformManaged,
		instance.Priority, instance.MonthlyQuotaMinutes, instance.QuotaResetDay,
		instance.AutoSwitchEnabled, instance.SwitchThresholdMinutes,
		instance.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update livekit instance: %w", err)
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

func (r *sqliteLiveKitRepo) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM livekit_instances WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete livekit instance: %w", err)
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

// ListPlatformInstances returns all instances (both platform-managed and
// self-hosted) for the admin panel. Despite the legacy name, this is what
// the admin LiveKit Sunucuları page lists; quota panel uses the same data.
// Filtering by is_platform_managed is the caller's job (UI badge / quota math).
func (r *sqliteLiveKitRepo) ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	query := `SELECT ` + instanceColumns + ` FROM livekit_instances ORDER BY priority ASC, created_at ASC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list livekit instances: %w", err)
	}
	defer rows.Close()

	var instances []models.LiveKitInstance
	for rows.Next() {
		var inst models.LiveKitInstance
		if err := scanInstance(rows, &inst); err != nil {
			return nil, fmt.Errorf("failed to scan livekit instance row: %w", err)
		}
		instances = append(instances, inst)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating livekit instance rows: %w", err)
	}

	return instances, nil
}

// ListAllInstances returns all LiveKit instances regardless of platform-managed flag.
// Only id, api_key, api_secret are needed — used by webhook HMAC verification.
func (r *sqliteLiveKitRepo) ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id, api_key, api_secret FROM livekit_instances`)
	if err != nil {
		return nil, fmt.Errorf("list all livekit instances: %w", err)
	}
	defer rows.Close()

	var instances []models.LiveKitInstance
	for rows.Next() {
		var inst models.LiveKitInstance
		if err := rows.Scan(&inst.ID, &inst.APIKey, &inst.APISecret); err != nil {
			return nil, fmt.Errorf("scan livekit instance: %w", err)
		}
		instances = append(instances, inst)
	}
	return instances, nil
}

// MigrateServers moves all servers from one instance to another within a transaction.
func (r *sqliteLiveKitRepo) MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error) {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return 0, fmt.Errorf("MigrateServers requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	var count int64
	err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE livekit_instance_id = ?`, fromInstanceID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count servers to migrate: %w", err)
	}

	if count == 0 {
		return 0, nil
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ?`,
		toInstanceID, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to migrate servers: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = 0 WHERE id = ?`, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to reset source server count: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + ? WHERE id = ?`,
		count, toInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update target server count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("failed to commit migration transaction: %w", err)
	}

	return count, nil
}

// MigrateOneServer moves a single server to a different LiveKit instance within a transaction.
func (r *sqliteLiveKitRepo) MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("MigrateOneServer requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	var oldInstanceID sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT livekit_instance_id FROM servers WHERE id = ?`, serverID,
	).Scan(&oldInstanceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return pkg.ErrNotFound
		}
		return fmt.Errorf("failed to get server current instance: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE id = ?`,
		newInstanceID, serverID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server instance: %w", err)
	}

	// Decrement old instance count if it changed
	if oldInstanceID.Valid && oldInstanceID.String != "" && oldInstanceID.String != newInstanceID {
		_, err = tx.ExecContext(ctx,
			`UPDATE livekit_instances SET server_count = MAX(server_count - 1, 0) WHERE id = ?`,
			oldInstanceID.String,
		)
		if err != nil {
			return fmt.Errorf("failed to decrement old instance count: %w", err)
		}
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + 1 WHERE id = ?`,
		newInstanceID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment new instance count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit single server migration: %w", err)
	}

	return nil
}

// ─── Quota tracking ──────────────────────────────────────────────────────

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
