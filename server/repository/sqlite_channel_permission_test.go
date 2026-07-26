// Real-DB characterization for the channel_permissions override store — the
// row-level source the ChannelPermissionService resolves against. Pins the
// upsert (ON CONFLICT) semantics of Set, the role-set filtering of
// GetByChannelAndRoles / GetByRoles, and Delete's not-found contract, so a
// change to the SQL surfaces here rather than as a silent authz shift.
package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// newChannelPermRepos builds a server (channel + one role) through the prod
// retry wrapper and adds a second role, returning what the override tests need.
func newChannelPermRepos(t *testing.T) (channelID, roleA, roleB, serverID string, permRepo ChannelPermissionRepository) {
	t.Helper()
	d := newTestDB(t)
	serverRepo := NewSQLiteServerRepo(wrapForRepo(d))
	roleRepo := NewSQLiteRoleRepo(wrapForRepo(d))
	channelRepo := NewSQLiteChannelRepo(wrapForRepo(d))
	categoryRepo := NewSQLiteCategoryRepo(wrapForRepo(d))
	messageRepo := NewSQLiteMessageRepo(wrapForRepo(d))
	userRepo := NewSQLiteUserRepo(wrapForRepo(d))

	sid, cid, rid, _ := seedFullServer(t, struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo})

	// A second role so the role-set filtering paths are meaningful.
	second := &models.Role{ServerID: sid, Name: "second", Color: "#000", Permissions: models.PermReadMessages}
	if err := roleRepo.Create(context.Background(), second); err != nil {
		t.Fatalf("create second role: %v", err)
	}

	return cid, rid, second.ID, sid, NewSQLiteChannelPermRepo(wrapForRepo(d))
}

func TestSQLiteChannelPerm_SetUpsertGetDelete(t *testing.T) {
	channelID, roleA, _, _, permRepo := newChannelPermRepos(t)
	ctx := context.Background()

	// Insert.
	if err := permRepo.Set(ctx, &models.ChannelPermissionOverride{
		ChannelID: channelID, RoleID: roleA,
		Allow: models.PermSendMessages, Deny: models.PermReadMessages,
	}); err != nil {
		t.Fatalf("Set insert: %v", err)
	}

	got, err := permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		t.Fatalf("GetByChannel: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("GetByChannel returned %d rows, want 1", len(got))
	}
	if got[0].Allow != models.PermSendMessages || got[0].Deny != models.PermReadMessages {
		t.Errorf("override = allow %b / deny %b, want allow %b / deny %b",
			got[0].Allow, got[0].Deny, models.PermSendMessages, models.PermReadMessages)
	}

	// Upsert the same (channel, role): ON CONFLICT replaces allow/deny, does
	// not insert a second row.
	if err := permRepo.Set(ctx, &models.ChannelPermissionOverride{
		ChannelID: channelID, RoleID: roleA,
		Allow: models.PermViewChannel, Deny: 0,
	}); err != nil {
		t.Fatalf("Set upsert: %v", err)
	}
	got, _ = permRepo.GetByChannel(ctx, channelID)
	if len(got) != 1 {
		t.Fatalf("after upsert: %d rows, want 1 (ON CONFLICT must update in place)", len(got))
	}
	if got[0].Allow != models.PermViewChannel || got[0].Deny != 0 {
		t.Errorf("after upsert: allow %b / deny %b, want allow %b / deny 0", got[0].Allow, got[0].Deny, models.PermViewChannel)
	}

	// Delete existing -> ok; delete again -> not-found contract.
	if err := permRepo.Delete(ctx, channelID, roleA); err != nil {
		t.Fatalf("Delete existing: %v", err)
	}
	if err := permRepo.Delete(ctx, channelID, roleA); err == nil {
		t.Error("Delete of a missing override must return an error (not a silent no-op)")
	}
	got, _ = permRepo.GetByChannel(ctx, channelID)
	if len(got) != 0 {
		t.Errorf("after delete: %d rows, want 0", len(got))
	}
}

func TestSQLiteChannelPerm_FilterByRoles(t *testing.T) {
	channelID, roleA, roleB, _, permRepo := newChannelPermRepos(t)
	ctx := context.Background()

	mustSet := func(role string, allow, deny models.Permission) {
		if err := permRepo.Set(ctx, &models.ChannelPermissionOverride{
			ChannelID: channelID, RoleID: role, Allow: allow, Deny: deny,
		}); err != nil {
			t.Fatalf("Set(%s): %v", role, err)
		}
	}
	mustSet(roleA, models.PermSendMessages, 0)
	mustSet(roleB, 0, models.PermReadMessages)

	// GetByChannel: both.
	if got, _ := permRepo.GetByChannel(ctx, channelID); len(got) != 2 {
		t.Errorf("GetByChannel = %d rows, want 2", len(got))
	}

	// GetByChannelAndRoles: only the requested role's override.
	got, err := permRepo.GetByChannelAndRoles(ctx, channelID, []string{roleA})
	if err != nil {
		t.Fatalf("GetByChannelAndRoles: %v", err)
	}
	if len(got) != 1 || got[0].RoleID != roleA {
		t.Errorf("GetByChannelAndRoles([roleA]) = %+v, want only roleA", got)
	}

	// Empty role set short-circuits to nil without a query error.
	if got, err := permRepo.GetByChannelAndRoles(ctx, channelID, nil); err != nil || got != nil {
		t.Errorf("GetByChannelAndRoles(nil) = (%v, %v), want (nil, nil)", got, err)
	}

	// GetByRoles: across channels, filtered to the role set.
	got, err = permRepo.GetByRoles(ctx, []string{roleB})
	if err != nil {
		t.Fatalf("GetByRoles: %v", err)
	}
	if len(got) != 1 || got[0].RoleID != roleB {
		t.Errorf("GetByRoles([roleB]) = %+v, want only roleB", got)
	}
	if got, err := permRepo.GetByRoles(ctx, nil); err != nil || got != nil {
		t.Errorf("GetByRoles(nil) = (%v, %v), want (nil, nil)", got, err)
	}
}

func TestSQLiteChannelPerm_DeleteAllByChannel(t *testing.T) {
	channelID, roleA, roleB, _, permRepo := newChannelPermRepos(t)
	ctx := context.Background()

	_ = permRepo.Set(ctx, &models.ChannelPermissionOverride{ChannelID: channelID, RoleID: roleA, Allow: models.PermSendMessages})
	_ = permRepo.Set(ctx, &models.ChannelPermissionOverride{ChannelID: channelID, RoleID: roleB, Deny: models.PermReadMessages})

	if err := permRepo.DeleteAllByChannel(ctx, channelID); err != nil {
		t.Fatalf("DeleteAllByChannel: %v", err)
	}
	if got, _ := permRepo.GetByChannel(ctx, channelID); len(got) != 0 {
		t.Errorf("after DeleteAllByChannel: %d rows, want 0", len(got))
	}
	// No-op on a channel with no overrides must not error.
	if err := permRepo.DeleteAllByChannel(ctx, channelID); err != nil {
		t.Errorf("DeleteAllByChannel on empty channel must be a no-op, got %v", err)
	}
}
