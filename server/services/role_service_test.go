// role_service permission-invalidation contract pins.
//
// The cache mechanics (InvalidateAll/InvalidateUser + TTL semantics)
// are covered in channel_permission_service_test.go. What this file
// pins is the CALL SITES: every write path that changes what
// ResolveChannelPermissions would return must call the invalidator.
//
// Without this, a future refactor could quietly drop the call and
// nothing would fail until a user reported "my ban didn't take effect
// for 30 seconds" — a class of bug that's hard to diagnose because it
// depends on cache-fill timing.

package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// countingInvalidator records how often InvalidateAll and InvalidateUser
// were called, and with which user IDs, so tests can assert exact
// invalidation semantics.
type countingInvalidator struct {
	allCount        int
	userCount       int
	invalidatedUser []string
}

func (c *countingInvalidator) InvalidateAll()             { c.allCount++ }
func (c *countingInvalidator) InvalidateUser(uid string)  {
	c.userCount++
	c.invalidatedUser = append(c.invalidatedUser, uid)
}

// newRoleSvcWithInvalidator wires roleService + countingInvalidator.
// Role hierarchy stub matches the pattern in member_service_test.go:
// actor holds a top-position PermAll role so hierarchy checks pass.
func newRoleSvcWithInvalidator(t *testing.T) (
	RoleService, *testutil.MockRoleRepo, *countingInvalidator,
) {
	t.Helper()
	roleRepo := &testutil.MockRoleRepo{}
	svc := NewRoleService(roleRepo, &testutil.MockUserRepo{}, &testutil.MockBroadcaster{}, nil) // auditLogger — not under test here
	inv := &countingInvalidator{}
	svc.SetPermInvalidator(inv)

	// Actor has top role → hierarchy checks pass; PermAll → escalation
	// checks also pass so tests can freely set any permissions.
	roleRepo.GetByUserIDAndServerFn = func(_ context.Context, uid, _ string) ([]models.Role, error) {
		if uid == "actor" {
			return []models.Role{
				{ID: "actor-top", Position: 100, Permissions: models.PermAll},
			}, nil
		}
		return nil, nil
	}

	return svc, roleRepo, inv
}

// perm helper — returns a *models.Permission for UpdateRoleRequest.
func permPtr(p models.Permission) *models.Permission {
	return &p
}

func TestRoleUpdate_WithPermissionChange_InvalidatesAll(t *testing.T) {
	svc, roleRepo, inv := newRoleSvcWithInvalidator(t)

	roleRepo.GetByIDFn = func(_ context.Context, id string) (*models.Role, error) {
		return &models.Role{
			ID: id, ServerID: "s-1", Position: 10, Permissions: 0,
		}, nil
	}

	newPerms := permPtr(models.PermSendMessages)
	_, err := svc.Update(context.Background(), "s-1", "actor", "r-1",
		&models.UpdateRoleRequest{Permissions: newPerms})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	if inv.allCount != 1 {
		t.Errorf("InvalidateAll count = %d, want 1 — permission change did not invalidate cache",
			inv.allCount)
	}
	if inv.userCount != 0 {
		t.Errorf("InvalidateUser count = %d, want 0 — a role edit affects "+
			"everyone with that role, so InvalidateAll is the correct call", inv.userCount)
	}
}

func TestRoleUpdate_WithCosmeticChangeOnly_DoesNotInvalidate(t *testing.T) {
	// Cosmetic edits (name / color / mentionable) don't affect any
	// resolved permission — invalidating the whole cache for a rename
	// would blow it every time an admin fixes a typo.
	svc, roleRepo, inv := newRoleSvcWithInvalidator(t)

	roleRepo.GetByIDFn = func(_ context.Context, id string) (*models.Role, error) {
		return &models.Role{
			ID: id, ServerID: "s-1", Position: 10, Name: "old-name",
		}, nil
	}

	newName := "new-name"
	_, err := svc.Update(context.Background(), "s-1", "actor", "r-1",
		&models.UpdateRoleRequest{Name: &newName})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	if inv.allCount != 0 {
		t.Errorf("InvalidateAll = %d, want 0 — cosmetic edit blew the "+
			"whole cache; that's a perf regression", inv.allCount)
	}
}

func TestRoleDelete_AlwaysInvalidatesAll(t *testing.T) {
	// Deletion strips this role's bits from every member who held it.
	// Enumerating members would be expensive, so InvalidateAll is the
	// intentionally-coarse call — always, unconditionally.
	svc, roleRepo, inv := newRoleSvcWithInvalidator(t)

	roleRepo.GetByIDFn = func(_ context.Context, id string) (*models.Role, error) {
		return &models.Role{
			ID: id, ServerID: "s-1", Position: 10, Name: "gone",
		}, nil
	}

	if err := svc.Delete(context.Background(), "s-1", "actor", "r-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if inv.allCount != 1 {
		t.Errorf("InvalidateAll = %d, want 1 — role deletion did not "+
			"invalidate cache; members keep stale permissions", inv.allCount)
	}
}
