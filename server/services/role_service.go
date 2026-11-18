package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var roleLogger = logx.Component("service.role")

// RoleService handles role CRUD. All operations are server-scoped.
type RoleService interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error)
	Create(ctx context.Context, serverID, actorID string, req *models.CreateRoleRequest) (*models.Role, error)
	Update(ctx context.Context, serverID, actorID, roleID string, req *models.UpdateRoleRequest) (*models.Role, error)
	Delete(ctx context.Context, serverID, actorID, roleID string) error
	ReorderRoles(ctx context.Context, serverID, actorID string, items []models.PositionUpdate) ([]models.Role, error)
}

type roleService struct {
	roleRepo         repository.RoleRepository
	roleTransactions repository.ServerRoleTxRunner
	hub              ws.Broadcaster
	auditLogger      AuditWriter
	permInvalidator  PermissionInvalidator
}

// invalidatePerms is a nil-safe wrapper — the invalidator is optional
// (test setups frequently leave it nil), so every call site goes
// through here instead of repeating the nil check.
func (s *roleService) invalidatePerms() {
	if s.permInvalidator != nil {
		s.permInvalidator.InvalidateAll()
	}
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
// Same observability pattern as voiceService.audit and memberService.audit:
// both branches log so "I created/deleted a role / assigned it but audit
// channel stayed empty" reports can be diagnosed from runtime logs.
func (s *roleService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		roleLogger.Warn("audit event dropped, auditLogger not wired", "event_type", entry.EventType, "server_id", entry.ServerID)
		return
	}
	roleLogger.Info("audit event emitted", "event_type", entry.EventType, "server_id", entry.ServerID)
	s.auditLogger.Write(entry)
}

func NewRoleService(
	roleRepo repository.RoleRepository,
	roleTransactions repository.ServerRoleTxRunner,
	hub ws.Broadcaster,
	auditLogger AuditWriter,
	permInvalidator PermissionInvalidator,
) RoleService {
	return &roleService{
		permInvalidator:  permInvalidator,
		roleRepo:         roleRepo,
		roleTransactions: roleTransactions,
		hub:              hub,
		auditLogger:      auditLogger,
	}
}

func (s *roleService) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	return s.roleRepo.GetAllByServer(ctx, serverID)
}

func (s *roleService) Create(ctx context.Context, serverID, actorID string, req *models.CreateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Permission escalation check
	actorPerms, permErr := s.getActorEffectivePermissions(ctx, actorID, serverID)
	if permErr != nil {
		return nil, permErr
	}
	if !actorPerms.Has(models.PermAdmin) {
		escalated := req.Permissions &^ actorPerms
		if escalated != 0 {
			return nil, fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
		}
	}

	allRoles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get all roles: %w", err)
	}

	// Shift all non-default roles up by 1 to make room at position 2
	var shifts []models.PositionUpdate
	for _, r := range allRoles {
		if r.IsDefault {
			continue
		}
		shifts = append(shifts, models.PositionUpdate{ID: r.ID, Position: r.Position + 1})
	}
	if len(shifts) > 0 {
		if err := s.roleRepo.UpdatePositions(ctx, shifts); err != nil {
			return nil, fmt.Errorf("failed to shift role positions: %w", err)
		}
	}

	newPosition := 2

	mentionable := true
	if req.Mentionable != nil {
		mentionable = *req.Mentionable
	}

	role := &models.Role{
		ServerID:    serverID,
		Name:        req.Name,
		Color:       req.Color,
		Position:    newPosition,
		Permissions: req.Permissions,
		Mentionable: mentionable,
	}

	if err := s.roleRepo.Create(ctx, role); err != nil {
		return nil, fmt.Errorf("failed to create role: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpRoleCreate,
		Data: role,
	})

	actor := actorID
	s.audit(models.AuditLog{
		ServerID:    serverID,
		ActorUserID: &actor,
		EventType:   models.AuditEventRoleCreate,
		Metadata:    fmt.Sprintf(`{"role_name":%q}`, role.Name),
	})

	return role, nil
}

func (s *roleService) Update(ctx context.Context, serverID, actorID, roleID string, req *models.UpdateRoleRequest) (*models.Role, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	var updated *models.Role
	err := s.roleTransactions.WithServerRoles(ctx, serverID, func(repos *repository.ServerMembershipTxRepos) error {
		actorRoles, actorPerms, err := roleManagerPermissions(ctx, repos, serverID, actorID)
		if err != nil {
			return err
		}
		role, err := repos.Role.GetByID(ctx, roleID)
		if err != nil {
			return err
		}
		if role.ServerID != serverID {
			return pkg.ErrNotFound
		}
		patch := *req
		if role.IsOwner {
			if !models.HasOwnerRole(actorRoles) {
				return fmt.Errorf("%w: only the server owner can modify the Owner role", pkg.ErrForbidden)
			}
			if patch.Permissions != nil {
				return fmt.Errorf("%w: Owner role permissions cannot be changed", pkg.ErrForbidden)
			}
			// Only the owner's name and color are editable.
			patch.Mentionable = nil
		} else {
			if role.Position >= models.HighestPosition(actorRoles) {
				return fmt.Errorf("%w: cannot modify a role with equal or higher position", pkg.ErrForbidden)
			}
			if patch.Permissions != nil && !actorPerms.Has(models.PermAdmin) && *patch.Permissions&^actorPerms != 0 {
				return fmt.Errorf("%w: cannot grant permissions you do not have", pkg.ErrForbidden)
			}
		}
		updated, err = repos.Role.Patch(ctx, serverID, roleID, patch)
		return err
	})
	if err != nil {
		return nil, err
	}
	if req.Permissions != nil {
		s.invalidatePerms()
	}
	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpRoleUpdate, Data: updated})
	return updated, nil
}

func roleManagerPermissions(ctx context.Context, repos *repository.ServerMembershipTxRepos, serverID, actorID string) ([]models.Role, models.Permission, error) {
	member, err := repos.Server.IsMember(ctx, serverID, actorID)
	if err != nil {
		return nil, 0, err
	}
	if !member {
		return nil, 0, pkg.ErrForbidden
	}
	roles, err := repos.Role.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return nil, 0, err
	}
	var perms models.Permission
	for _, role := range roles {
		perms |= role.Permissions
	}
	if !perms.Has(models.PermManageRoles) {
		return nil, 0, pkg.ErrForbidden
	}
	return roles, perms, nil
}

func (s *roleService) Delete(ctx context.Context, serverID, actorID, roleID string) error {
	role, err := s.roleRepo.GetByID(ctx, roleID)
	if err != nil {
		return err
	}
	if role.ServerID != serverID {
		return fmt.Errorf("%w: role not found", pkg.ErrNotFound)
	}

	if role.IsOwner {
		return fmt.Errorf("%w: the Owner role cannot be deleted", pkg.ErrForbidden)
	}

	if role.IsDefault {
		return fmt.Errorf("%w: cannot delete the default role", pkg.ErrBadRequest)
	}

	actorMaxPos, err := s.getActorMaxPosition(ctx, actorID, serverID)
	if err != nil {
		return err
	}

	if role.Position >= actorMaxPos {
		return fmt.Errorf("%w: cannot delete a role with equal or higher position", pkg.ErrForbidden)
	}

	if err := s.roleRepo.Delete(ctx, roleID); err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}

	// Deletion strips this role's contribution from every member who
	// held it — always invalidate the resolution cache.
	s.invalidatePerms()

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpRoleDelete,
		Data: map[string]string{"id": roleID},
	})

	actor := actorID
	s.audit(models.AuditLog{
		ServerID:    serverID,
		ActorUserID: &actor,
		EventType:   models.AuditEventRoleDelete,
		Metadata:    fmt.Sprintf(`{"role_name":%q}`, role.Name),
	})

	return nil
}

func (s *roleService) ReorderRoles(ctx context.Context, serverID, actorID string, items []models.PositionUpdate) ([]models.Role, error) {
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: items cannot be empty", pkg.ErrBadRequest)
	}

	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get actor roles: %w", err)
	}
	actorMaxPos := models.HighestPosition(actorRoles)

	isOwner := models.HasOwnerRole(actorRoles)

	for _, item := range items {
		role, err := s.roleRepo.GetByID(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if role.ServerID != serverID {
			return nil, fmt.Errorf("%w: role not found", pkg.ErrNotFound)
		}

		if role.IsOwner {
			return nil, fmt.Errorf("%w: the Owner role cannot be reordered", pkg.ErrForbidden)
		}

		if role.IsDefault {
			return nil, fmt.Errorf("%w: cannot reorder the default role", pkg.ErrBadRequest)
		}

		if !isOwner {
			if role.Position >= actorMaxPos {
				return nil, fmt.Errorf("%w: cannot reorder a role with equal or higher position", pkg.ErrForbidden)
			}
			if item.Position >= actorMaxPos {
				return nil, fmt.Errorf("%w: cannot move a role to equal or higher position than your own", pkg.ErrForbidden)
			}
		}
	}

	if err := s.roleRepo.UpdatePositions(ctx, items); err != nil {
		return nil, fmt.Errorf("failed to update role positions: %w", err)
	}

	roles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload roles after reorder: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpRolesReorder,
		Data: roles,
	})

	return roles, nil
}

func (s *roleService) getActorMaxPosition(ctx context.Context, actorID, serverID string) (int, error) {
	actorRoles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}
	return models.HighestPosition(actorRoles), nil
}

func (s *roleService) getActorEffectivePermissions(ctx context.Context, actorID, serverID string) (models.Permission, error) {
	roles, err := s.roleRepo.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return 0, fmt.Errorf("failed to get actor roles: %w", err)
	}

	var perms models.Permission
	for _, r := range roles {
		perms |= r.Permissions
	}
	return perms, nil
}
