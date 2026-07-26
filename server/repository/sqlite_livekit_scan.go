package repository

// Scan helpers shared across the sqlite LiveKit repository: the canonical
// column list plus the row-scanning shim used by every SELECT.

import "github.com/argeinfina/hichat/models"

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
