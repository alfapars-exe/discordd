package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// MemberService handles member management. All operations are server-scoped.
type MemberService interface {
	GetAll(ctx context.Context, serverID string) ([]models.MemberWithRoles, error)
	GetByID(ctx context.Context, serverID, userID string) (*models.MemberWithRoles, error)
	UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error)
	UpdatePresence(ctx context.Context, userID string, status models.UserStatus) error
	ModifyRoles(ctx context.Context, serverID, actorID, targetID string, roleIDs []string) (*models.MemberWithRoles, error)
	Kick(ctx context.Context, serverID, actorID, targetID string) error
	// Ban now accepts an optional duration (nil = permanent). Temp ban
	// auto-lifts when the row's expires_at passes — no cleanup job.
	Ban(ctx context.Context, serverID, actorID, targetID, reason string, expiresAt *time.Time) error
	Unban(ctx context.Context, serverID, actorID, userID string) error
	GetBans(ctx context.Context, serverID string) ([]models.Ban, error)
	IsBanned(ctx context.Context, serverID, userID string) (bool, error)
	// Timeout — Discord-style: user stays in the server but Send-Message
	// + Join-Voice + Add-Reaction are blocked until expiresAt. Re-applying
	// extends the existing timeout (upsert).
	Timeout(ctx context.Context, serverID, actorID, targetID string, expiresAt time.Time, reason string) error
	RemoveTimeout(ctx context.Context, serverID, actorID, targetID string) error
	// IsTimedOut — fast hot-path check returning the active timeout (if
	// any). nil result means the user is free to act.
	IsTimedOut(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error)
	// SetNickname applies a per-server nickname. nil or "" clears.
	// Caller (handler/route) enforces PermManageNicknames for non-self.
	SetNickname(ctx context.Context, serverID, actorID, targetID string, nickname *string) (*models.MemberWithRoles, error)
	SetAuditLogger(logger AuditWriter)
}

// VoiceDisconnecter disconnects a user from voice on kick/ban (ISP).
type VoiceDisconnecter interface {
	DisconnectUser(userID string)
}

type memberService struct {
	userRepo    repository.UserRepository
	roleRepo    repository.RoleRepository
	banRepo     repository.BanRepository
	timeoutRepo repository.MemberTimeoutRepository
	serverRepo  repository.ServerRepository
	hub         ws.BroadcastAndManage
	voiceKick   VoiceDisconnecter
	auditLogger AuditWriter
}

func (s *memberService) SetAuditLogger(logger AuditWriter) {
	s.auditLogger = logger
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
//
// Logs both branches so a "I kicked X / banned Y but the audit channel
// stayed empty" report tells us exactly where the pipeline dropped:
// nil logger ⇒ main.go SetAuditLogger wiring regressed; otherwise look
// at [audit_log] downstream logs from audit_log_service.persistAndBroadcast
// for Insert / broadcast outcomes. Same pattern as voiceService.audit.
func (s *memberService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		log.Printf("[member/audit] DROPPED event=%s server=%s (auditLogger not wired)", entry.EventType, entry.ServerID)
		return
	}
	log.Printf("[member/audit] emit event=%s server=%s", entry.EventType, entry.ServerID)
	s.auditLogger.Write(entry)
}

func NewMemberService(
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	banRepo repository.BanRepository,
	timeoutRepo repository.MemberTimeoutRepository,
	serverRepo repository.ServerRepository,
	hub ws.BroadcastAndManage,
	voiceKick VoiceDisconnecter,
) MemberService {
	return &memberService{
		userRepo:    userRepo,
		roleRepo:    roleRepo,
		banRepo:     banRepo,
		timeoutRepo: timeoutRepo,
		serverRepo:  serverRepo,
		hub:         hub,
		voiceKick:   voiceKick,
	}
}

func (s *memberService) GetAll(ctx context.Context, serverID string) ([]models.MemberWithRoles, error) {
	users, err := s.userRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}

	// One round-trip for all per-server nicknames — avoids the N+1 we'd
	// get from calling GetNickname inside the loop.
	nicknames, err := s.serverRepo.GetNicknamesForServer(ctx, serverID)
	if err != nil {
		// Non-fatal — fall back to "no nicknames" instead of failing the
		// whole member list fetch.
		log.Printf("[member] failed to load nicknames for server %s: %v", serverID, err)
		nicknames = map[string]string{}
	}

	members := make([]models.MemberWithRoles, 0)
	for i := range users {
		isMember, err := s.serverRepo.IsMember(ctx, serverID, users[i].ID)
		if err != nil {
			return nil, fmt.Errorf("failed to check membership: %w", err)
		}
		if !isMember {
			continue
		}

		roles, err := s.roleRepo.GetByUserIDAndServer(ctx, users[i].ID, serverID)
		if err != nil {
			return nil, fmt.Errorf("failed to get roles for user %s: %w", users[i].ID, err)
		}
		m := models.ToMemberWithRoles(&users[i], roles)
		if nick, ok := nicknames[users[i].ID]; ok && nick != "" {
			n := nick
			m.Nickname = &n
		}
		members = append(members, m)
	}

	return members, nil
}

func (s *memberService) GetByID(ctx context.Context, serverID, userID string) (*models.MemberWithRoles, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles for user: %w", err)
	}

	member := models.ToMemberWithRoles(user, roles)
	// Per-server nickname — non-fatal if it fails (we still return the
	// member, just without the per-server override).
	if nick, nerr := s.serverRepo.GetNickname(ctx, serverID, userID); nerr == nil && nick != nil {
		member.Nickname = nick
	}
	return &member, nil
}

// SetNickname applies a per-server nickname. Self-rename is always
// allowed (no permission check). Changing OTHER members' nicknames
// requires PermManageNicknames — checked here so the handler stays
// thin and so unit tests can cover both branches.
func (s *memberService) SetNickname(ctx context.Context, serverID, actorID, targetID string, nickname *string) (*models.MemberWithRoles, error) {
	if actorID != targetID {
		actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve actor roles: %w", err)
		}
		var perms models.Permission
		for _, role := range actorRoles {
			perms |= role.Permissions
		}
		if !perms.Has(models.PermManageNicknames) {
			return nil, fmt.Errorf("%w: manage nicknames permission required", pkg.ErrForbidden)
		}
	}

	if err := s.serverRepo.SetNickname(ctx, serverID, targetID, nickname); err != nil {
		return nil, err
	}

	// Reload the full member view so the response carries the new
	// nickname (and the WS broadcast below has the canonical row).
	updated, err := s.GetByID(ctx, serverID, targetID)
	if err != nil {
		return nil, err
	}

	// Same WS op the regular member_update path uses, so existing
	// client handlers (memberStore, voiceStore, messageStore) refresh
	// their cached display names without any new wiring.
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: updated,
	})

	// Optional audit row — useful when a moderator renames someone
	// other than themselves. Self-renames don't generate noise.
	if actorID != targetID {
		actor := actorID
		target := targetID
		meta := "{}"
		if nickname != nil && *nickname != "" {
			meta = fmt.Sprintf(`{"nickname":%q}`, strings.ReplaceAll(*nickname, `"`, `\"`))
		}
		s.audit(models.AuditLog{
			ServerID:     serverID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    models.AuditEventMemberNicknameChange,
			Metadata:     meta,
		})
	}

	return updated, nil
}

func (s *memberService) UpdateProfile(ctx context.Context, userID string, req *models.UpdateProfileRequest) (*models.MemberWithRoles, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	if req.Username != nil && !strings.EqualFold(*req.Username, user.Username) {
		existing, existErr := s.userRepo.GetByUsername(ctx, *req.Username)
		if existErr == nil && existing.ID != userID {
			return nil, fmt.Errorf("%w: username is already taken", pkg.ErrAlreadyExists)
		}
		if existErr != nil && !errors.Is(existErr, pkg.ErrNotFound) {
			return nil, fmt.Errorf("failed to check username availability: %w", existErr)
		}
		user.Username = *req.Username
	}
	if req.DisplayName != nil {
		if *req.DisplayName == "" {
			user.DisplayName = nil
		} else {
			user.DisplayName = req.DisplayName
		}
	}
	if req.AvatarURL != nil {
		user.AvatarURL = req.AvatarURL
	}
	if req.CustomStatus != nil {
		if *req.CustomStatus == "" {
			user.CustomStatus = nil
		} else {
			user.CustomStatus = req.CustomStatus
		}
	}
	if req.Language != nil {
		user.Language = *req.Language
	}
	if req.DMPrivacy != nil {
		user.DMPrivacy = *req.DMPrivacy
	}

	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user profile: %w", err)
	}

	// Broadcast to all servers the user belongs to (not BroadcastToAll)
	member := models.ToMemberWithRoles(user, nil)
	servers, srvErr := s.serverRepo.GetUserServers(ctx, userID)
	if srvErr == nil {
		for _, srv := range servers {
			s.hub.BroadcastToServer(srv.ID, ws.Event{
				Op:   ws.OpMemberUpdate,
				Data: &member,
			})
		}
	}

	return &member, nil
}

func (s *memberService) UpdatePresence(ctx context.Context, userID string, status models.UserStatus) error {
	if err := s.userRepo.UpdateStatus(ctx, userID, status); err != nil {
		return fmt.Errorf("failed to update presence: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpPresence,
		Data: map[string]string{
			"user_id": userID,
			"status":  string(status),
		},
	})

	return nil
}

func (s *memberService) ModifyRoles(ctx context.Context, serverID, actorID, targetID string, roleIDs []string) (*models.MemberWithRoles, error) {
	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get actor roles: %w", err)
	}
	actorMaxPos := models.HighestPosition(actorRoles)

	targetRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, targetID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get target roles: %w", err)
	}
	targetMaxPos := models.HighestPosition(targetRoles)

	if models.HasOwnerRole(targetRoles) {
		return nil, fmt.Errorf("%w: cannot modify the server owner's roles", pkg.ErrForbidden)
	}

	if targetMaxPos >= actorMaxPos {
		return nil, fmt.Errorf("%w: cannot modify roles of a user with equal or higher role", pkg.ErrForbidden)
	}

	for _, roleID := range roleIDs {
		role, err := s.roleRepo.GetByID(ctx, roleID)
		if err != nil {
			return nil, fmt.Errorf("role %s not found: %w", roleID, err)
		}
		if role.Position >= actorMaxPos {
			return nil, fmt.Errorf("%w: cannot assign role '%s' with equal or higher position", pkg.ErrForbidden, role.Name)
		}
	}

	currentSet := make(map[string]bool, len(targetRoles))
	for _, r := range targetRoles {
		currentSet[r.ID] = true
	}

	targetSet := make(map[string]bool, len(roleIDs))
	for _, id := range roleIDs {
		targetSet[id] = true
	}

	// Track assignments + removals so we can emit one audit event per role
	// transition. Doing this in a single pass keeps the audit channel
	// readable instead of dumping a wall of "X modified roles" entries.
	actor := actorID
	target := targetID
	for _, id := range roleIDs {
		if !currentSet[id] {
			if err := s.roleRepo.AssignToUser(ctx, targetID, id, serverID); err != nil {
				return nil, fmt.Errorf("failed to assign role: %w", err)
			}
			if role, _ := s.roleRepo.GetByID(ctx, id); role != nil {
				s.audit(models.AuditLog{
					ServerID:     serverID,
					ActorUserID:  &actor,
					TargetUserID: &target,
					EventType:    models.AuditEventRoleAssign,
					Metadata:     fmt.Sprintf(`{"role_name":%q}`, role.Name),
				})
			}
		}
	}

	for _, r := range targetRoles {
		if !targetSet[r.ID] {
			if r.IsDefault {
				continue
			}
			if r.Position >= actorMaxPos {
				continue
			}
			if err := s.roleRepo.RemoveFromUser(ctx, targetID, r.ID); err != nil {
				return nil, fmt.Errorf("failed to remove role: %w", err)
			}
			s.audit(models.AuditLog{
				ServerID:     serverID,
				ActorUserID:  &actor,
				TargetUserID: &target,
				EventType:    models.AuditEventRoleRemove,
				Metadata:     fmt.Sprintf(`{"role_name":%q}`, r.Name),
			})
		}
	}

	member, err := s.GetByID(ctx, serverID, targetID)
	if err != nil {
		return nil, err
	}

	// Role changes are server-scoped — only broadcast to that server
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpMemberUpdate,
		Data: member,
	})

	return member, nil
}

func (s *memberService) Kick(ctx context.Context, serverID, actorID, targetID string) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot kick yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, serverID, actorID, targetID); err != nil {
		return err
	}

	if err := s.serverRepo.RemoveMember(ctx, serverID, targetID); err != nil {
		return fmt.Errorf("failed to kick user: %w", err)
	}

	s.removeFromServer(serverID, targetID)

	actor := actorID
	target := targetID
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &actor,
		TargetUserID: &target,
		EventType:    models.AuditEventMemberKick,
	})
	return nil
}

// Ban — permanent OR temp ban depending on expiresAt:
//   - nil       → permanent (original behaviour, original audit shape)
//   - non-nil   → temp ban; the row's expires_at column is set, the
//                 BanRepository's WHERE filter hides it after the
//                 timestamp, and the ban silently lifts itself.
//
// Either way the user is removed from the server membership and
// force-disconnected from voice. Re-banning an already-banned user
// (e.g. extending an existing temp ban) is idempotent — the repo's
// INSERT OR REPLACE refreshes the row in place.
func (s *memberService) Ban(ctx context.Context, serverID, actorID, targetID, reason string, expiresAt *time.Time) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	if err := s.checkHierarchy(ctx, serverID, actorID, targetID); err != nil {
		return err
	}

	target, err := s.userRepo.GetByID(ctx, targetID)
	if err != nil {
		return fmt.Errorf("failed to get target user: %w", err)
	}

	ban := &models.Ban{
		ServerID:  serverID,
		UserID:    targetID,
		Username:  target.Username,
		Reason:    reason,
		BannedBy:  actorID,
		ExpiresAt: expiresAt,
	}

	if err := s.banRepo.Create(ctx, ban); err != nil {
		return fmt.Errorf("failed to create ban: %w", err)
	}

	// Remove membership (best-effort — ban already created)
	if rmErr := s.serverRepo.RemoveMember(ctx, serverID, targetID); rmErr != nil {
		log.Printf("[member] failed to remove member after ban server=%s user=%s: %v", serverID, targetID, rmErr)
	}

	s.removeFromServer(serverID, targetID)

	// Audit pointer locals — `target` is already taken by the *models.User
	// fetched at the top of this function, so we can't reuse the name.
	auditActor := actorID
	auditTarget := targetID
	metadata := buildModerationMetadata(reason, expiresAt)
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &auditActor,
		TargetUserID: &auditTarget,
		EventType:    models.AuditEventMemberBan,
		Metadata:     metadata,
	})
	return nil
}

// buildModerationMetadata — JSON-safe encoder for the optional `reason`
// and optional `expires_at` fields shared by Ban + Timeout audit rows.
// Keeps the inline-string JSON pattern member_service was already using
// for Ban so we don't pull in encoding/json just for two keys.
func buildModerationMetadata(reason string, expiresAt *time.Time) string {
	parts := make([]string, 0, 2)
	if reason != "" {
		escaped := strings.ReplaceAll(reason, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"`, `\"`)
		parts = append(parts, fmt.Sprintf(`"reason":%q`, escaped))
	}
	if expiresAt != nil {
		parts = append(parts, fmt.Sprintf(`"expires_at":%q`, expiresAt.UTC().Format(time.RFC3339)))
	}
	if len(parts) == 0 {
		return "{}"
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// removeFromServer handles post-kick/ban cleanup: voice disconnect, WS broadcasts, subscription removal.
// Order matters: broadcast before removing subscription so the kicked user receives the events.
func (s *memberService) removeFromServer(serverID, targetID string) {
	if s.voiceKick != nil {
		s.voiceKick.DisconnectUser(targetID)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   targetID,
		},
	})

	s.hub.BroadcastToUser(targetID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	s.hub.RemoveClientServerID(targetID, serverID)
}

func (s *memberService) Unban(ctx context.Context, serverID, actorID, userID string) error {
	if err := s.banRepo.Delete(ctx, serverID, userID); err != nil {
		return err
	}

	actor := actorID
	target := userID
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &actor,
		TargetUserID: &target,
		EventType:    models.AuditEventMemberUnban,
	})
	return nil
}

func (s *memberService) GetBans(ctx context.Context, serverID string) ([]models.Ban, error) {
	return s.banRepo.GetAllByServer(ctx, serverID)
}

func (s *memberService) IsBanned(ctx context.Context, serverID, userID string) (bool, error) {
	return s.banRepo.Exists(ctx, serverID, userID)
}

// Timeout — apply or extend a Discord-style timeout. Unlike Ban, the
// user stays in the server: no membership removal, no voice kick (we
// could disconnect from voice but we leave them connected so the UX
// matches "muted in their seat"; voiceService blocks new joins).
// Hierarchy check is the same as Ban — moderators can't mute their
// equals or the server owner.
func (s *memberService) Timeout(
	ctx context.Context,
	serverID, actorID, targetID string,
	expiresAt time.Time,
	reason string,
) error {
	if actorID == targetID {
		return fmt.Errorf("%w: cannot timeout yourself", pkg.ErrBadRequest)
	}
	if err := s.checkHierarchy(ctx, serverID, actorID, targetID); err != nil {
		return err
	}
	t := &models.MemberTimeout{
		ServerID:  serverID,
		UserID:    targetID,
		ExpiresAt: expiresAt.UTC(),
		AppliedBy: actorID,
		Reason:    reason,
	}
	if err := s.timeoutRepo.Upsert(ctx, t); err != nil {
		return fmt.Errorf("failed to apply timeout: %w", err)
	}
	// Broadcast so every connected client refreshes its muted-member
	// state immediately — no polling. Both the target's clients (so
	// their UI shows "you are timed out until …") and other members
	// (so the badge appears next to the name).
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberTimeout,
		Data: map[string]any{
			"server_id":  serverID,
			"user_id":    targetID,
			"expires_at": t.ExpiresAt,
			"reason":     reason,
		},
	})

	auditActor := actorID
	auditTarget := targetID
	expCopy := t.ExpiresAt
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &auditActor,
		TargetUserID: &auditTarget,
		EventType:    models.AuditEventMemberTimeout,
		Metadata:     buildModerationMetadata(reason, &expCopy),
	})
	return nil
}

func (s *memberService) RemoveTimeout(ctx context.Context, serverID, actorID, targetID string) error {
	if err := s.timeoutRepo.Delete(ctx, serverID, targetID); err != nil {
		return err
	}
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberTimeoutRemove,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   targetID,
		},
	})
	auditActor := actorID
	auditTarget := targetID
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &auditActor,
		TargetUserID: &auditTarget,
		EventType:    models.AuditEventMemberTimeoutRemove,
	})
	return nil
}

func (s *memberService) IsTimedOut(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error) {
	return s.timeoutRepo.Get(ctx, serverID, userID)
}

func (s *memberService) checkHierarchy(ctx context.Context, serverID, actorID, targetID string) error {
	targetRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, targetID, serverID)
	if err != nil {
		return fmt.Errorf("failed to get target roles: %w", err)
	}

	if models.HasOwnerRole(targetRoles) {
		return fmt.Errorf("%w: the server owner cannot be kicked or banned", pkg.ErrForbidden)
	}

	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return fmt.Errorf("failed to get actor roles: %w", err)
	}

	actorMaxPos := models.HighestPosition(actorRoles)
	targetMaxPos := models.HighestPosition(targetRoles)

	if actorMaxPos <= targetMaxPos {
		return fmt.Errorf("%w: insufficient role hierarchy", pkg.ErrForbidden)
	}

	return nil
}
