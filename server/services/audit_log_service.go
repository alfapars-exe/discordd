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
	"log"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

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
// have on server Y".
type ServerRoleResolver interface {
	GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error)
}

type auditLogService struct {
	repo      repository.AuditLogRepository
	userRepo  repository.UserRepository
	roleRepo  ServerRoleResolver
	hub       ws.Broadcaster
	hubOnline ws.UserStateProvider

	ch     chan models.AuditLog
	cancel context.CancelFunc
	done   chan struct{}
}

// NewAuditLogService constructs the service. Call Start() to begin
// the async writer.
func NewAuditLogService(
	repo repository.AuditLogRepository,
	userRepo repository.UserRepository,
	roleRepo ServerRoleResolver,
	hub ws.Broadcaster,
	hubOnline ws.UserStateProvider,
) AuditLogService {
	return &auditLogService{
		repo:      repo,
		userRepo:  userRepo,
		roleRepo:  roleRepo,
		hub:       hub,
		hubOnline: hubOnline,
		ch:        make(chan models.AuditLog, 256),
		done:      make(chan struct{}),
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
		log.Printf("[audit_log] buffer full, dropping event: %s", entry.EventType)
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
func (s *auditLogService) allowedViewers(serverID string) []string {
	ctx := context.Background()
	online := s.hubOnline.GetOnlineUserIDsForServer(serverID)
	allowed := make([]string, 0, len(online))
	for _, userID := range online {
		roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
		if err != nil {
			continue
		}
		var perms models.Permission
		for _, r := range roles {
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

	go func() {
		defer close(s.done)
		for {
			select {
			case <-ctx.Done():
				s.drain()
				return
			case entry := <-s.ch:
				s.persistAndBroadcast(entry)
			}
		}
	}()
}

func (s *auditLogService) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	<-s.done
	log.Println("[audit_log] stopped")
}

// drain flushes remaining entries from the channel before exit. Mirrors
// the same pattern as appLogService.drain().
func (s *auditLogService) drain() {
	for {
		select {
		case entry := <-s.ch:
			s.persistAndBroadcast(entry)
		default:
			return
		}
	}
}

func (s *auditLogService) persistAndBroadcast(entry models.AuditLog) {
	ctx := context.Background()

	if err := s.repo.Insert(ctx, &entry); err != nil {
		log.Printf("[audit_log] failed to insert: %v event=%s server=%s", err, entry.EventType, entry.ServerID)
		return
	}
	// The repo populates the row's id + created_at from SQLite defaults but
	// doesn't reflect them back into our local copy. Stamp CreatedAt here
	// so the broadcast payload has a timestamp clients can use for ordering
	// even before their initial /audit fetch completes. ID stays empty in
	// the broadcast; clients dedupe with the fetched canonical row on next
	// reload (rare, low-impact for audit history).
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}

	viewers := s.allowedViewers(entry.ServerID)
	// Observability: log every persisted audit row + viewer count. Helps
	// diagnose "I did X but the audit channel didn't update" reports —
	// no log means s.audit() never reached the buffer (auditLogger nil
	// or Write dropped); 0 viewers means broadcast skipped (clients see
	// it on next fetchInitial DB read). One line per event is cheap; this
	// is the only place every successful audit emission converges.
	log.Printf("[audit_log] persisted event=%s server=%s actor=%v target=%v viewers=%d",
		entry.EventType, entry.ServerID, entry.ActorUserID, entry.TargetUserID, len(viewers))
	if len(viewers) > 0 {
		s.hub.BroadcastToUsers(viewers, ws.Event{
			Op:   ws.OpAuditEvent,
			Data: entry,
		})
	}
}
