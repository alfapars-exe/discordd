package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

func TestLeaveServerInvalidatesDepartingUserPermissions(t *testing.T) {
	inv := &memberInvalidator{}
	svc := &serverService{
		serverRepo: &testutil.MockServerRepo{GetByIDFn: func(context.Context, string) (*models.Server, error) {
			return &models.Server{OwnerID: "owner"}, nil
		}},
		hub: &testutil.MockEventPublisher{},
	}
	svc.SetPermInvalidator(inv)
	if err := svc.LeaveServer(context.Background(), "server", "member"); err != nil {
		t.Fatal(err)
	}
	if len(inv.userCalls) != 1 || inv.userCalls[0] != "member" {
		t.Fatalf("invalidated users = %v", inv.userCalls)
	}
}
func TestPrivateChannelPermissionsAcrossLeaveAndRejoin(t *testing.T) {
	ctx := context.Background()
	h := newJoinServerHarness()
	roles := []models.Role{{ID: "reader", Permissions: models.PermReadMessages | models.PermViewChannel}}
	h.roleRepo.GetByUserIDAndServerFn = func(context.Context, string, string) ([]models.Role, error) { return roles, nil }
	h.serverRepo.RemoveMemberFn = func(context.Context, string, string) error { roles = nil; return nil }
	h.roleRepo.AssignToUserFn = func(_ context.Context, _, roleID, _ string) error {
		roles = []models.Role{{ID: roleID, Permissions: models.PermViewChannel}}
		return nil
	}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: joinTestServerID, Type: models.ChannelTypeText}, nil
	}}
	cache := NewChannelPermissionService(&testutil.MockChannelPermRepo{}, h.roleRepo, channels, h.hub)
	h.svc.SetPermInvalidator(cache)
	check := func(want models.Permission) {
		t.Helper()
		got, err := cache.ResolveChannelPermissions(ctx, joinTestUserID, "private")
		if err != nil || got != want {
			t.Fatalf("private channel permissions = %v, want %v, err = %v", got, want, err)
		}
	}
	check(models.PermViewChannel | models.PermReadMessages)
	if err := h.svc.LeaveServer(ctx, joinTestServerID, joinTestUserID); err != nil {
		t.Fatal(err)
	}
	check(0)
	if _, err := h.svc.JoinServer(ctx, joinTestUserID, joinTestCode); err != nil {
		t.Fatal(err)
	}
	check(models.PermViewChannel)
}
