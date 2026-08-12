// Package services — server membership: join, leave, and personal server ordering.
package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// joinServerTx runs AddMember and (when defaultRoleID is non-empty)
// AssignToUser atomically via membershipTxRunner. Before this, the two ran
// as separate non-transactional calls: a failure in AssignToUser after a
// successful AddMember left the user a member with zero roles — often zero
// permissions (no PermViewChannel from the default role), a silently
// broken half-joined state. Either both land or neither does now.
//
// defaultRoleID being empty (default role lookup failed, or the server has
// no default role) is not an error here — JoinServer resolves and logs
// that failure itself before calling this; the membership row still gets
// created, just without a role assignment, matching the pre-fix behavior.
func (s *serverService) joinServerTx(ctx context.Context, serverID, userID, defaultRoleID string) error {
	return s.membershipTxRunner.InTx(ctx, func(r *repository.ServerMembershipTxRepos) error {
		if err := r.Server.AddMember(ctx, serverID, userID); err != nil {
			return fmt.Errorf("failed to add member: %w", err)
		}
		if defaultRoleID != "" {
			if err := r.Role.AssignToUser(ctx, userID, defaultRoleID, serverID); err != nil {
				return fmt.Errorf("failed to assign default role: %w", err)
			}
		}
		return nil
	})
}

// JoinServer joins a server via invite code.
func (s *serverService) JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error) {
	invite, err := s.inviteService.Validate(ctx, inviteCode)
	if err != nil {
		return nil, err
	}

	serverID := invite.ServerID

	isMember, err := s.serverRepo.IsMember(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check membership: %w", err)
	}
	if isMember {
		return nil, fmt.Errorf("%w: already a member of this server", pkg.ErrBadRequest)
	}

	// N-02: a valid invite code doesn't override an active ban — without
	// this check a banned user could just ask for (or reuse) an invite link
	// to walk right back in. Exists() already excludes expired temp bans
	// (see repository/sqlite_ban.go), so a lapsed ban never blocks the join.
	banned, err := s.banRepo.Exists(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check ban status: %w", err)
	}
	if banned {
		return nil, fmt.Errorf("%w: you are banned from this server", pkg.ErrForbidden)
	}

	// Default role lookup happens BEFORE the membership transaction, and its
	// error handling is unchanged from before this fix: a missing/errored
	// default role is a server-config issue, not a reason to block the
	// join — log it and proceed with an empty defaultRoleID, which
	// joinServerTx treats as "add the member, skip the role assignment".
	var defaultRoleID string
	if defaultRole, err := s.roleRepo.GetDefaultByServer(ctx, serverID); err != nil {
		serverLogger.Error("failed to get default role for server", "server_id", serverID, "err", pkg.ErrText(err))
	} else {
		defaultRoleID = defaultRole.ID
	}

	// AddMember + AssignToUser now run atomically (server_service_crud.go's
	// joinServerTx) — see its doc comment for why a partial join (member
	// row with no role) was worth closing.
	if err := s.joinServerTx(ctx, serverID, userID, defaultRoleID); err != nil {
		return nil, err
	}

	// B3: burn the invite's use slot only once membership actually landed —
	// incrementing earlier wasted a max_uses slot on joins that later failed
	// (already-a-member, AddMember error). Stays outside the transaction
	// above and best-effort (logged, not propagated): invites are a
	// separate resource from membership, and losing a use-count decrement
	// to a rare failure is far cheaper than losing an otherwise-successful
	// join over it.
	if err := s.inviteService.MarkUsed(ctx, inviteCode); err != nil {
		serverLogger.Error("failed to mark invite used", "invite_code", inviteCode, "err", pkg.ErrText(err))
	}

	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	// Add server to user's WS subscription list
	s.hub.AddClientServerID(userID, serverID)

	// Notify user: server added to their list
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: server.IconURL,
		},
	})

	// Notify server members: new member joined (full MemberWithRoles for frontend)
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		serverLogger.Error("failed to get user for member_join broadcast", "user_id", userID, "err", pkg.ErrText(err))
	} else {
		roles, _ := s.roleRepo.GetByUserIDAndServer(ctx, userID, serverID)
		member := models.ToMemberWithRoles(user, roles)
		s.hub.BroadcastToServer(serverID, ws.Event{
			Op:   ws.OpMemberJoin,
			Data: member,
		})
	}

	// Audit: member joined via invite. Actor == target (the joining user)
	// because invite-based join is self-initiated. The i18n template only
	// references {{target}}, so the duplicate snapshot is harmless.
	actor := userID
	target := userID
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &actor,
		TargetUserID: &target,
		EventType:    models.AuditEventMemberJoin,
	})

	serverLogger.Info("user joined server via invite", "user_id", userID, "server_id", serverID)
	return server, nil
}

func (s *serverService) LeaveServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID == userID {
		return fmt.Errorf("%w: server owner cannot leave; transfer ownership first", pkg.ErrForbidden)
	}

	if err := s.serverRepo.RemoveMember(ctx, serverID, userID); err != nil {
		return fmt.Errorf("failed to remove member: %w", err)
	}

	// Notify server members (broadcast before removing subscription)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpMemberLeave,
		Data: map[string]string{
			"server_id": serverID,
			"user_id":   userID,
		},
	})

	// Notify user: server removed from their list
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Remove from WS subscription list
	s.hub.RemoveClientServerID(userID, serverID)

	// Audit: voluntary leave. Actor == target (kick has its own
	// member_kick event from member_service so we don't double-log).
	actor := userID
	target := userID
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &actor,
		TargetUserID: &target,
		EventType:    models.AuditEventMemberLeave,
	})

	serverLogger.Info("user left server", "user_id", userID, "server_id", serverID)
	return nil
}

// ReorderServers updates the user's personal server list order (per-user, no broadcast).
func (s *serverService) ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	if err := s.serverRepo.UpdateMemberPositions(ctx, userID, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update server positions: %w", err)
	}

	servers, err := s.serverRepo.GetUserServers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload servers after reorder: %w", err)
	}

	return servers, nil
}
