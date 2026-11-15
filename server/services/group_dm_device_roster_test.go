package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"reflect"
	"testing"
)

type groupRosterFixture struct {
	repository.GroupDMRepository
	epoch   int64
	members []string
	member  bool
	reads   int
	change  bool
	revoke  bool
	failure error
}

func (f *groupRosterFixture) GetByID(context.Context, string) (*models.GroupDM, error) {
	f.reads++
	if f.reads == 2 && f.change {
		f.epoch++
	}
	return &models.GroupDM{ID: "group", KeyEpoch: f.epoch}, nil
}
func (f *groupRosterFixture) IsMember(context.Context, string, string) (bool, error) {
	if f.reads == 2 && f.revoke {
		return false, nil
	}
	return f.member, nil
}
func (f *groupRosterFixture) ListMemberIDs(context.Context, string) ([]string, error) {
	return f.members, f.failure
}
func TestGroupDeviceRosterFreshEpochAndAccess(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		member, change, revoke bool
		members                []string
		failure, want          error
	}{
		{name: "current", member: true, members: []string{"me", "peer"}},
		{name: "outsider", members: []string{"me", "peer"}, want: pkg.ErrNotFound},
		{name: "removed during read", member: true, revoke: true, members: []string{"me", "peer"}, want: pkg.ErrNotFound},
		{name: "epoch changed during read", member: true, change: true, members: []string{"me", "peer"}, want: pkg.ErrConflict},
		{name: "mixed member list", member: true, members: []string{"peer"}, want: pkg.ErrNotFound},
		{name: "repository failure", member: true, failure: pkg.ErrForbidden, want: pkg.ErrForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &groupRosterFixture{epoch: 7, member: tc.member, change: tc.change, revoke: tc.revoke, members: tc.members, failure: tc.failure}
			s := &groupDMService{groups: f}
			epoch, ids, err := s.GetGroupDeviceRosterMembers(context.Background(), "me", "group")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
			if err != nil {
				if epoch != 0 || ids != nil {
					t.Fatal("partial roster returned on denial")
				}
				return
			}
			if epoch != 7 || !reflect.DeepEqual(ids, tc.members) {
				t.Fatalf("epoch=%d members=%v", epoch, ids)
			}
			f.member = false
			if _, _, err = s.GetGroupDeviceRosterMembers(context.Background(), "me", "group"); !errors.Is(err, pkg.ErrNotFound) {
				t.Fatalf("revoked membership reused: %v", err)
			}
		})
	}
}
