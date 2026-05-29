package services

// Moderation methods for memberService: kick, ban/unban, timeouts, and the
// hierarchy check + metadata helper they share. Split out of member_service.go
// (which keeps the member directory + profile/role management). These remain
// methods on the same *memberService type in the same package, so the
// MemberService interface, NewMemberService constructor, and wiring are
// unchanged.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

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

	// Kicked user shouldn't be holding live API connections anyway, but
	// drop their cached permissions defensively so any in-flight request
	// re-resolves against the now-empty membership.
	s.invalidateUserPerms(targetID)

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
//     BanRepository's WHERE filter hides it after the
//     timestamp, and the ban silently lifts itself.
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

	// Same rationale as Kick — drop cached permissions defensively.
	s.invalidateUserPerms(targetID)

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
