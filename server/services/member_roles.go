package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

func (s *memberService) ModifyRoles(ctx context.Context, serverID, actorID, targetID string, roleIDs []string) (*models.MemberWithRoles, error) {
	var member *models.MemberWithRoles
	var changes memberRoleChanges
	err := s.roleTransactions.WithServerRoles(ctx, serverID, func(repos *repository.ServerMembershipTxRepos) error {
		actorRoles, permissions, err := roleManagerPermissions(ctx, repos, serverID, actorID)
		if err != nil {
			return err
		}
		isMember, err := repos.Server.IsMember(ctx, serverID, targetID)
		if err != nil {
			return err
		}
		if !isMember {
			return pkg.ErrNotFound
		}

		current, err := repos.Role.GetByUserIDAndServer(ctx, targetID, serverID)
		if err != nil {
			return fmt.Errorf("load target roles: %w", err)
		}
		actorPosition := models.HighestPosition(actorRoles)
		if models.HasOwnerRole(current) {
			return fmt.Errorf("%w: cannot modify the server owner's roles", pkg.ErrForbidden)
		}
		if models.HighestPosition(current) >= actorPosition {
			return fmt.Errorf("%w: cannot modify roles of a user with equal or higher role", pkg.ErrForbidden)
		}
		available, err := repos.Role.GetAllByServer(ctx, serverID)
		if err != nil {
			return fmt.Errorf("load server roles: %w", err)
		}
		changes, err = replacementRoleChanges(current, available, roleIDs, actorPosition, permissions)
		if err != nil {
			return err
		}
		for _, role := range changes.add {
			if err := repos.Role.AssignToUser(ctx, targetID, role.ID, serverID); err != nil {
				return fmt.Errorf("assign role: %w", err)
			}
		}
		for _, role := range changes.remove {
			if err := repos.Role.RemoveFromUser(ctx, targetID, role.ID); err != nil {
				return fmt.Errorf("remove role: %w", err)
			}
		}
		reader := memberReader{userRepo: repos.User, roleRepo: repos.Role, serverRepo: repos.Server, timeoutRepo: repos.Timeout}
		member, err = reader.GetByID(ctx, serverID, targetID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if len(changes.add) == 0 && len(changes.remove) == 0 {
		return member, nil
	}

	s.invalidateUserPerms(targetID)
	writeAudit := func(event models.AuditEventType, name string) {
		s.audit(models.AuditLog{
			ServerID: serverID, ActorUserID: &actorID, TargetUserID: &targetID,
			EventType: event, Metadata: fmt.Sprintf(`{"role_name":%q}`, name),
		})
	}
	for _, role := range changes.add {
		writeAudit(models.AuditEventRoleAssign, role.Name)
	}
	for _, role := range changes.remove {
		writeAudit(models.AuditEventRoleRemove, role.Name)
	}
	public := *member
	public.RedactProfileFields()
	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpMemberUpdate, Data: &public})
	return member, nil
}

type memberRoleChanges struct{ add, remove []models.Role }

// replacementRoleChanges preserves the default role and rejects an invalid
// request as a whole before any assignments or removals are written.
func replacementRoleChanges(current, available []models.Role, requested []string, actorPosition int, actorPermissions models.Permission) (memberRoleChanges, error) {
	byID := make(map[string]models.Role, len(available))
	for _, r := range available {
		byID[r.ID] = r
	}
	held := make(map[string]bool, len(current))
	for _, r := range current {
		held[r.ID] = true
	}
	desired := make(map[string]bool, len(requested))
	var changes memberRoleChanges
	for _, id := range requested {
		if desired[id] {
			continue
		}
		desired[id] = true
		role, ok := byID[id]
		if !ok {
			return memberRoleChanges{}, fmt.Errorf("%w: role %s does not belong to this server", pkg.ErrForbidden, id)
		}
		if role.IsOwner || role.Position >= actorPosition {
			return memberRoleChanges{}, fmt.Errorf("%w: cannot assign role '%s' with equal or higher position", pkg.ErrForbidden, role.Name)
		}
		if held[id] {
			continue
		}
		if !actorPermissions.Has(models.PermAdmin) && role.Permissions&^actorPermissions != 0 {
			return memberRoleChanges{}, fmt.Errorf("%w: cannot assign permissions you do not have", pkg.ErrForbidden)
		}
		changes.add = append(changes.add, role)
	}
	for _, r := range current {
		if !r.IsDefault && !desired[r.ID] {
			changes.remove = append(changes.remove, r)
		}
	}
	return changes, nil
}
