package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// LiveKitRepository defines data access for LiveKit SFU instances and server mappings.
type LiveKitRepository interface {
	Create(ctx context.Context, instance *models.LiveKitInstance) error
	GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error)
	// GetByServerID returns the LiveKit instance linked to a server (JOIN on servers.livekit_instance_id).
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
	// GetLeastLoadedPlatformInstance returns the platform-managed instance with fewest servers (load balancing).
	GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error)
	IncrementServerCount(ctx context.Context, instanceID string) error
	DecrementServerCount(ctx context.Context, instanceID string) error
	Update(ctx context.Context, instance *models.LiveKitInstance) error
	Delete(ctx context.Context, id string) error
	ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error)
	// ListAllInstances returns all LiveKit instances (both platform-managed and self-hosted).
	// Used by webhook handler to verify HMAC signatures from any known instance.
	ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error)
	// MigrateServers moves all servers from one instance to another. Returns count of migrated servers.
	MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error)
	// MigrateOneServer moves a single server to a new instance (adjusts server_count on both).
	MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error

	// ─── Quota tracking ──────────────────────────────────────────────────
	// IncrementMonthlyUsage adds `seconds` to the (instance, year, month)
	// usage row, creating it on first write. Idempotent across crashes —
	// a duplicate call only inflates that row, never duplicates it.
	IncrementMonthlyUsage(ctx context.Context, instanceID string, year, month, seconds int) error
	// GetMonthlyUsage returns the accumulated session-seconds for one
	// instance in one calendar month. Returns 0 if no row exists yet.
	GetMonthlyUsage(ctx context.Context, instanceID string, year, month int) (int64, error)
	// ListInstancesWithQuota returns every instance (cloud + self-hosted)
	// alongside its current-month usage seconds (parallel slices, same
	// indexing). Self-hosted instances have UsedSeconds=0 always — caller
	// is expected to ignore quota math for them based on IsPlatformManaged.
	ListInstancesWithQuota(ctx context.Context, year, month int) ([]models.LiveKitInstance, []int64, error)
	// GetNextAutoSwitchInstance returns the lowest-priority cloud instance
	// (excluding currentID) that has at least SwitchThresholdMinutes free
	// in (year, month) and has auto_switch_enabled=1. Returns nil when no
	// eligible instance exists — caller falls back to staying on current.
	GetNextAutoSwitchInstance(ctx context.Context, currentID string, year, month int) (*models.LiveKitInstance, error)
	// UpdateQuotaSettings applies a partial update of the quota-related
	// columns. Nil fields are not touched. Used by the admin quota panel's
	// PATCH endpoint; kept distinct from Update() so the credential-touching
	// path stays narrow.
	UpdateQuotaSettings(ctx context.Context, instanceID string, settings *models.UpdateLiveKitQuotaSettingsRequest) error
}
