package services

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type dmRosterPolicy struct{ allow bool }

func (p dmRosterPolicy) CanCreate(context.Context, string, string) (bool, error) { return p.allow, nil }

func (p dmRosterPolicy) CanCreateWithReaders(context.Context, profilePreferenceReader, friendRequestServerReader, string, string) (bool, error) {
	return p.allow, nil
}

func TestDMDeviceRosterMembersAccess(t *testing.T) {
	for _, tc := range []struct {
		name, actor, status, privacy                                 string
		encrypted, blocked, friends, history, policy, admin, allowed bool
	}{
		{name: "member", actor: "alice", status: "accepted", encrypted: true, policy: true, allowed: true},
		{name: "outsider", actor: "carol", status: "accepted", encrypted: true, policy: true},
		{name: "pending", actor: "alice", status: "pending", encrypted: true, policy: true},
		{name: "unencrypted", actor: "alice", status: "accepted", policy: true},
		{name: "blocked", actor: "alice", status: "accepted", encrypted: true, blocked: true, policy: true},
		{name: "empty revoked server permission", actor: "alice", status: "accepted", encrypted: true},
		{name: "history retained", actor: "alice", status: "accepted", encrypted: true, history: true, allowed: true},
		{name: "friends retained", actor: "alice", status: "accepted", encrypted: true, friends: true, allowed: true},
		{name: "friends only denied", actor: "alice", status: "accepted", privacy: "friends_only", encrypted: true, history: true, policy: true},
		{name: "friends only allowed", actor: "alice", status: "accepted", privacy: "friends_only", encrypted: true, friends: true, allowed: true},
		{name: "platform admin send semantics", actor: "alice", status: "accepted", encrypted: true, blocked: true, admin: true, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDMFixtureWithPolicy(dmRosterPolicy{tc.policy})
			f.repo.GetChannelByIDFn = func(context.Context, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "ch", User1ID: "alice", User2ID: "bob", Status: tc.status, E2EEEnabled: tc.encrypted}, nil
			}
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, DMPrivacy: tc.privacy, IsPlatformAdmin: tc.admin && id == tc.actor}, nil
			}
			f.block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return tc.blocked, nil }
			f.friends.AreFriendsFn = func(context.Context, string, string) (bool, error) { return tc.friends, nil }
			f.repo.HasMessagesFn = func(context.Context, string) (bool, error) { return tc.history, nil }
			members, err := f.svc.GetDeviceRosterMembers(context.Background(), tc.actor, "ch")
			if tc.allowed {
				if err != nil || !reflect.DeepEqual(members, []string{"alice", "bob"}) {
					t.Fatalf("members=%v err=%v", members, err)
				}
			} else if !errors.Is(err, pkg.ErrForbidden) || len(members) != 0 {
				t.Fatalf("denied roster members=%v err=%v", members, err)
			}
		})
	}
}

func TestDMDeviceRosterMembersRechecksRevocation(t *testing.T) {
	policy := &dmRosterPolicy{allow: true}
	f := newDMFixtureWithPolicy(policy)
	f.repo.GetChannelByIDFn = func(context.Context, string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: "ch", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted, E2EEEnabled: true}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil }
	f.friends.AreFriendsFn = func(context.Context, string, string) (bool, error) { return false, nil }
	f.repo.HasMessagesFn = func(context.Context, string) (bool, error) { return false, nil }
	blocked := false
	f.block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return blocked, nil }
	ctx := context.Background()
	if _, err := f.svc.GetDeviceRosterMembers(ctx, "alice", "ch"); err != nil {
		t.Fatal(err)
	}
	policy.allow = false
	if members, err := f.svc.GetDeviceRosterMembers(ctx, "alice", "ch"); !errors.Is(err, pkg.ErrForbidden) || len(members) != 0 {
		t.Fatalf("revoked policy members=%v err=%v", members, err)
	}
	policy.allow = true
	blocked = true
	if members, err := f.svc.GetDeviceRosterMembers(ctx, "alice", "ch"); !errors.Is(err, pkg.ErrForbidden) || len(members) != 0 {
		t.Fatalf("new block members=%v err=%v", members, err)
	}
}
