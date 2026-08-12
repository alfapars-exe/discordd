// Package services — audit log service: structured moderation history
// rendered as system messages in audit channels.
//
// Architecture:
//   - Write() is non-blocking: events are enqueued on a buffered channel,
//     a background goroutine drains them into the DB and broadcasts via WS.
//     Moderation hot paths (mute, kick, ban) never block on log writes.
//   - List() runs synchronously and is permission-gated. Only users with
//     PermAdmin / Kick / Ban / Mute / Deafen on the server may read.
//   - Broadcast() filters online server members by the same permission set
//     so clients without view rights never receive the WS event in the
//     first place — defense in depth on top of the endpoint check.
package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var auditLogger = logx.Component("service.auditlog")

// AuditLogService is the public API for writing and reading audit events.
type AuditLogService interface {
	// Write enqueues an event for async persistence + broadcast. Returns
	// without waiting for the DB write — the writer goroutine handles it.
	Write(entry models.AuditLog)
	// List returns paginated audit entries for a server. Caller must have
	// audit-view permission (PermAdmin || Kick/Ban/Mute/Deafen members).
	List(ctx context.Context, userID string, filter models.AuditLogFilter) ([]models.AuditLog, error)
	// Start begins the writer goroutine.
	Start()
	// Stop drains the buffer and exits the writer goroutine.
	Stop()
}

// ServerRoleResolver — narrow ISP interface so audit_log_service doesn't
// depend on the full role service. Only needs "what perms does user X
// have on server Y", one user at a time for the read gate and in bulk for
// the broadcast recipient filter.
type ServerRoleResolver interface {
	GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error)
	GetRolesForUsers(ctx context.Context, serverID string, userIDs []string) (map[string][]models.Role, error)
}

type auditLogService struct {
	repo      repository.AuditLogRepository
	userRepo  repository.UserRepository
	roleRepo  ServerRoleResolver
	hub       ws.Broadcaster
	hubOnline ws.UserStateProvider

	// retentionDays is how long an audit_logs row is kept before the
	// background purge deletes it. <= 0 disables the purge (config.Config's
	// AuditLogRetentionDays doc explains why 0 is a deliberate "keep
	// forever" choice here, not a fallback-to-default case).
	retentionDays int

	ch     chan models.AuditLog
	cancel context.CancelFunc
	done   chan struct{}
}

// NewAuditLogService constructs the service. Call Start() to begin
// the async writer. retentionDays <= 0 disables the auto-purge loop.
func NewAuditLogService(
	repo repository.AuditLogRepository,
	userRepo repository.UserRepository,
	roleRepo ServerRoleResolver,
	hub ws.Broadcaster,
	hubOnline ws.UserStateProvider,
	retentionDays int,
) AuditLogService {
	return &auditLogService{
		repo:          repo,
		userRepo:      userRepo,
		roleRepo:      roleRepo,
		hub:           hub,
		hubOnline:     hubOnline,
		retentionDays: retentionDays,
		ch:            make(chan models.AuditLog, 256),
		done:          make(chan struct{}),
	}
}

// canViewAudit returns true if the given permission bitfield allows
// viewing the audit channel. Mirrors the client's check in
// useAuditPermission so both layers stay consistent.
func canViewAudit(perms models.Permission) bool {
	return perms.Has(models.PermAdmin) ||
		perms.Has(models.PermKickMembers) ||
		perms.Has(models.PermBanMembers) ||
		perms.Has(models.PermMuteMembers) ||
		perms.Has(models.PermDeafenMembers)
}

func (s *auditLogService) Write(entry models.AuditLog) {
	// Default metadata to "{}" so the wire shape is consistent for clients
	// that always JSON.parse it.
	if entry.Metadata == "" {
		entry.Metadata = "{}"
	}
	// Fill snapshots from current user records if the caller didn't.
	// Doing it here (vs in every call site) keeps the call-site one-liner.
	ctx := context.Background()
	if entry.ActorSnapshot == nil && entry.ActorUserID != nil {
		entry.ActorSnapshot = s.userSnapshot(ctx, *entry.ActorUserID)
	}
	if entry.TargetSnapshot == nil && entry.TargetUserID != nil {
		entry.TargetSnapshot = s.userSnapshot(ctx, *entry.TargetUserID)
	}

	select {
	case s.ch <- entry:
	default:
		auditLogger.Warn("buffer full, dropping event", "event_type", entry.EventType)
	}
}

// userSnapshot looks up a user and returns a frozen snapshot for embedding
// in the audit row. Returns nil on lookup failure — the entry still
// renders with "Bilinmeyen kullanıcı" fallback on the client.
func (s *auditLogService) userSnapshot(ctx context.Context, userID string) *models.UserSnapshot {
	u, err := s.userRepo.GetByID(ctx, userID)
	if err != nil || u == nil {
		return nil
	}
	snap := &models.UserSnapshot{
		ID:       u.ID,
		Username: u.Username,
	}
	if u.DisplayName != nil {
		snap.DisplayName = *u.DisplayName
	}
	if u.AvatarURL != nil {
		snap.AvatarURL = *u.AvatarURL
	}
	return snap
}

func (s *auditLogService) List(
	ctx context.Context,
	userID string,
	filter models.AuditLogFilter,
) ([]models.AuditLog, error) {
	// Permission gate: only audit-viewers may read. Roles are server-scoped,
	// so resolve via roleRepo.GetByUserIDAndServer and OR the perm bits.
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, filter.ServerID)
	if err != nil {
		return nil, fmt.Errorf("resolve user roles: %w", err)
	}
	var perms models.Permission
	for _, r := range roles {
		perms |= r.Permissions
	}
	if !canViewAudit(perms) {
		return nil, fmt.Errorf("%w: audit channel requires moderator permission", pkg.ErrForbidden)
	}

	return s.repo.ListByServer(ctx, filter)
}

// allowedViewers returns the online server-member user IDs that pass
// canViewAudit. Mirrors message_service.allowedViewers — only iterates
// the currently connected users for the given server so we don't scan
// every member of every server on every event.
//
// Roles come from one batched query. Asking per user cost one round trip per
// online member on every single audit event; audit events are emitted from a
// background drain loop, so that latency compounded behind the queue.
func (s *auditLogService) allowedViewers(ctx context.Context, serverID string) []string {
	online := s.hubOnline.GetOnlineUserIDsForServer(serverID)
	if len(online) == 0 {
		return nil
	}

	rolesByUser, err := s.roleRepo.GetRolesForUsers(ctx, serverID, online)
	if err != nil {
		auditLogger.Error("bulk role resolve failed", "server_id", serverID, "err", pkg.ErrText(err))
		return nil
	}

	allowed := make([]string, 0, len(online))
	for _, userID := range online {
		var perms models.Permission
		for _, r := range rolesByUser[userID] {
			perms |= r.Permissions
		}
		if canViewAudit(perms) {
			allowed = append(allowed, userID)
		}
	}
	return allowed
}

func (s *auditLogService) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	// Same async-writer shape as appLogService — wrapped so a panic here
	// can't crash the whole process (see pkg/logx.Go doc comment).
	logx.Go("audit_log.writer", func() {
		defer close(s.done)
		for {
			select {
			case <-ctx.Done():
				s.drain()
				return
			case entry := <-s.ch:
				s.persistAndBroadcast(ctx, entry)
			}
		}
	})
	logx.Go("audit_log.auto_purge", func() { s.autoPurgeLoop(ctx) })
}

// auditLogPurgeInterval controls how often the retention purge checks;
// mirrors appLogService.autoPurgeLoop's 6-hour cadence.
const auditLogPurgeInterval = 6 * time.Hour

// autoPurgeLoop deletes audit_logs rows older than retentionDays, checking
// every auditLogPurgeInterval. A no-op loop when retentionDays <= 0 — see
// the retentionDays field doc for why 0 means "keep forever" here rather
// than falling back to a default.
func (s *auditLogService) autoPurgeLoop(ctx context.Context) {
	if s.retentionDays <= 0 {
		return
	}
	ticker := time.NewTicker(auditLogPurgeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().AddDate(0, 0, -s.retentionDays).UTC().Format("2006-01-02 15:04:05")
			deleted, err := s.repo.DeleteBefore(ctx, cutoff)
			if err != nil {
				auditLogger.Error("auto-purge failed", "err", pkg.ErrText(err))
			} else if deleted > 0 {
				auditLogger.Info("auto-purge deleted old audit logs", "count", deleted, "retention_days", s.retentionDays)
			}
		}
	}
}

func (s *auditLogService) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	<-s.done
	auditLogger.Info("audit log service stopped")
}

// drain flushes remaining entries from the channel before exit. Mirrors
// the same pattern as appLogService.drain().
func (s *auditLogService) drain() {
	for {
		select {
		case entry := <-s.ch:
			s.persistAndBroadcast(context.Background(), entry)
		default:
			return
		}
	}
}

func (s *auditLogService) persistAndBroadcast(ctx context.Context, entry models.AuditLog) {

	if err := s.repo.Insert(ctx, &entry); err != nil {
		auditLogger.Error("failed to insert audit entry",
			"err", pkg.ErrText(err), "event_type", entry.EventType, "server_id", entry.ServerID)
		return
	}
	// After Track R the repo populates entry.ID + entry.CreatedAt via
	// INSERT ... RETURNING, so the broadcast carries the canonical row id.
	// Keep the timestamp fallback for paranoia — on a legacy SQLite < 3.35
	// (which doesn't support RETURNING) the Scan would error and we'd
	// never reach this point, but if a future repo implementation silently
	// no-ops the populate, this stamp at least keeps client ordering sane.
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}

	viewers := s.allowedViewers(ctx, entry.ServerID)
	// Observability: log every persisted audit row + viewer count. The id is
	// included so we can verify Track R's RETURNING fix at a glance — if we
	// ever see id="" again, the repo regressed. Helps diagnose "I did X but
	// the audit channel didn't update" reports — no log means s.audit()
	// never reached the buffer (auditLogger nil or Write dropped); 0 viewers
	// means broadcast skipped (clients see it on next fetchInitial DB read).
	auditLogger.Info("audit entry persisted",
		"id", entry.ID, "event_type", entry.EventType, "server_id", entry.ServerID,
		"actor_id", entry.ActorUserID, "target_id", entry.TargetUserID, "viewers", len(viewers))
	if len(viewers) > 0 {
		s.hub.BroadcastToUsers(viewers, ws.Event{
			Op:   ws.OpAuditEvent,
			Data: entry,
		})
	}
}
