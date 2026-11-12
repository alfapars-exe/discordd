package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

func TestParentOverrideInvalidatesWarmThreadReaders(t *testing.T) {
	ctx := context.Background()
	parentID := "parent"
	channelReads := make(map[string]int)
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		channelReads[id]++
		channel := &models.Channel{ID: id, ServerID: "server", Type: models.ChannelTypeText}
		if id == "thread" {
			channel.Type, channel.ParentChannelID = models.ChannelTypeThread, &parentID
		}
		return channel, nil
	}}
	reader := models.Role{ID: "reader", ServerID: "server", Position: 1, Permissions: models.PermReadMessages | models.PermViewChannel}
	roles := &testutil.MockRoleRepo{
		GetByIDFn: func(context.Context, string) (*models.Role, error) { return &reader, nil },
		GetByUserIDAndServerFn: func(_ context.Context, user, _ string) ([]models.Role, error) {
			if user == "admin" {
				return []models.Role{{Position: 10, Permissions: models.PermAdmin}}, nil
			}
			return []models.Role{reader}, nil
		},
		GetRolesForUsersFn: func(_ context.Context, _ string, users []string) (map[string][]models.Role, error) {
			result := make(map[string][]models.Role, len(users))
			for _, user := range users {
				result[user] = []models.Role{reader}
			}
			return result, nil
		},
	}
	overrides := make(map[string][]models.ChannelPermissionOverride)
	permRepo := &testutil.MockChannelPermRepo{
		GetByChannelAndRolesFn: func(_ context.Context, id string, _ []string) ([]models.ChannelPermissionOverride, error) {
			return overrides[id], nil
		},
		GetByChannelFn: func(_ context.Context, id string) ([]models.ChannelPermissionOverride, error) {
			return overrides[id], nil
		},
		SetFn: func(_ context.Context, o *models.ChannelPermissionOverride) error {
			overrides[o.ChannelID] = []models.ChannelPermissionOverride{*o}
			return nil
		},
		DeleteFn: func(_ context.Context, id, _ string) error { delete(overrides, id); return nil },
	}
	svc := NewChannelPermissionService(permRepo, roles, channels, &testutil.MockBroadcaster{})
	assertSingle := func(user, channel string, want bool) {
		t.Helper()
		perms, err := svc.ResolveChannelPermissions(ctx, user, channel)
		if err != nil || models.PermCanReadChannel(perms) != want {
			t.Fatalf("single read %s/%s: want readable=%v, got %v, err=%v", user, channel, want, perms, err)
		}
	}
	assertBulk := func(user string, want bool) {
		t.Helper()
		perms, err := svc.ResolveChannelPermissionsBulk(ctx, "thread", []string{user})
		if err != nil || models.PermCanReadChannel(perms[user]) != want {
			t.Fatalf("bulk thread read for %s: want readable=%v, got %v, err=%v", user, want, perms[user], err)
		}
	}

	assertSingle("alice", "other", true)
	assertSingle("alice", "thread", true)
	assertBulk("bob", true)
	if err := svc.SetOverride(ctx, "server", parentID, reader.ID, "admin", &models.SetOverrideRequest{Deny: models.PermReadMessages}); err != nil {
		t.Fatal(err)
	}
	assertBulk("alice", false)
	assertSingle("bob", "thread", false)
	assertSingle("alice", "other", true)
	if err := svc.DeleteOverride(ctx, "server", parentID, reader.ID, "admin"); err != nil {
		t.Fatal(err)
	}
	assertSingle("alice", "thread", true)
	assertBulk("bob", true)
	assertSingle("alice", "other", true)
	if channelReads["other"] != 1 {
		t.Errorf("unrelated channel queried %d times, want 1", channelReads["other"])
	}
}
