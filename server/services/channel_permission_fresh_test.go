package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

func TestMusicAccessFreshPermissionBypassesPositiveCacheAndHonorsInvalidation(t *testing.T) {
	mask := models.PermViewChannel | models.PermSpeak
	roles := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) {
		return []models.Role{{ID: "role", Permissions: mask}}, nil
	}}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
		return &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}, nil
	}}
	permissions := &testutil.MockChannelPermRepo{GetByChannelAndRolesFn: func(context.Context, string, []string) ([]models.ChannelPermissionOverride, error) { return nil, nil }}
	cached := NewChannelPermissionService(permissions, roles, channels, &testutil.MockBroadcaster{}).(*cachingPermResolver)
	if got, err := cached.ResolveChannelPermissions(context.Background(), "user", "ch"); err != nil || !got.Has(models.PermSpeak) {
		t.Fatal("positive cache fixture not seeded", err)
	}
	mask = models.PermViewChannel
	if got, err := cached.ResolveChannelPermissions(context.Background(), "user", "ch"); err != nil || !got.Has(models.PermSpeak) {
		t.Fatal("fixture did not retain positive cache", err)
	}
	if got, err := cached.ResolveChannelPermissionsFresh(context.Background(), "user", "ch"); err != nil || got.Has(models.PermSpeak) {
		t.Fatal("fresh music authorization reused positive cache", err)
	}
	calls := 0
	roles.GetByUserIDAndServerFn = func(context.Context, string, string) ([]models.Role, error) {
		calls++
		if calls == 1 {
			cached.InvalidateUser("user")
			return []models.Role{{ID: "role", Permissions: models.PermAll}}, nil
		}
		return []models.Role{{ID: "role", Permissions: models.PermViewChannel}}, nil
	}
	if got, err := cached.ResolveChannelPermissionsFresh(context.Background(), "user", "ch"); err != nil || got.Has(models.PermSpeak) || calls != 2 {
		t.Fatalf("in-flight invalidation fence failed: permission=%v calls=%d err=%v", got, calls, err)
	}
}
