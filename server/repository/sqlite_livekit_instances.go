package repository

// LiveKit instance CRUD: create/read/update/delete, server-count bookkeeping,
// and the admin-facing list queries.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

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
	return scanRows(rows, "livekit instance", func(rows *sql.Rows) (models.LiveKitInstance, error) {
		var inst models.LiveKitInstance
		err := scanInstance(rows, &inst)
		return inst, err
	})
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
