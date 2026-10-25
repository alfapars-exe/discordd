package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/repository"
)

type activityJoinServerStub struct {
	repository.ServerRepository
	count     int
	lockErr   error
	lockCalls int
	addCalls  int
	snapshot  bool
}

type activityJoinServerWithoutLockStub struct {
	repository.ServerRepository
	addCalls int
	snapshot bool
}

func (s *activityJoinServerWithoutLockStub) AddMemberWithGameActivityAudience(_ context.Context, _, _ string, allowed bool) error {
	s.addCalls++
	s.snapshot = allowed
	return nil
}

func (s *activityJoinServerStub) LockAndCountMembersForGameActivityJoin(context.Context, string) (int, error) {
	s.lockCalls++
	return s.count, s.lockErr
}

func (s *activityJoinServerStub) AddMemberWithGameActivityAudience(_ context.Context, _, _ string, allowed bool) error {
	s.addCalls++
	s.snapshot = allowed
	return nil
}

type activityJoinTxRunner struct{ server repository.ServerRepository }

func (r activityJoinTxRunner) InTx(ctx context.Context, fn func(*repository.ServerMembershipTxRepos) error) error {
	return fn(&repository.ServerMembershipTxRepos{Server: r.server})
}

func TestJoinServerTxLocksEveryAudienceAndFailsOnLockError(t *testing.T) {
	for _, tc := range []struct {
		name     string
		audience gameActivityAudience
		count    int
		want     bool
	}{
		{name: "all", audience: gameActivityAudienceAll, count: 500, want: true},
		{name: "small at boundary", audience: gameActivityAudienceSmall, count: 199, want: true},
		{name: "small over boundary", audience: gameActivityAudienceSmall, count: 200, want: false},
		{name: "none", audience: gameActivityAudienceNone, count: 10, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := &activityJoinServerStub{count: tc.count}
			svc := &serverService{membershipTxRunner: activityJoinTxRunner{server: server}}
			if err := svc.joinServerTx(context.Background(), "server", "user", "", tc.audience); err != nil {
				t.Fatal(err)
			}
			if server.lockCalls != 1 || server.addCalls != 1 || server.snapshot != tc.want {
				t.Fatalf("lockCalls=%d addCalls=%d snapshot=%t; want 1, 1, %t", server.lockCalls, server.addCalls, server.snapshot, tc.want)
			}
		})
	}

	t.Run("lock error aborts all join before insert", func(t *testing.T) {
		server := &activityJoinServerStub{lockErr: errors.New("lock failed")}
		svc := &serverService{membershipTxRunner: activityJoinTxRunner{server: server}}
		if err := svc.joinServerTx(context.Background(), "server", "user", "", gameActivityAudienceAll); err == nil {
			t.Fatal("expected lock error")
		}
		if server.addCalls != 0 {
			t.Fatalf("AddMember called %d times after lock failure", server.addCalls)
		}
	})

	for _, tc := range []struct {
		audience gameActivityAudience
		want     bool
	}{
		{audience: gameActivityAudienceAll, want: true},
		{audience: gameActivityAudienceNone, want: false},
		{audience: gameActivityAudienceSmall, want: false},
	} {
		t.Run("optional lock absent/"+string(tc.audience), func(t *testing.T) {
			server := &activityJoinServerWithoutLockStub{}
			svc := &serverService{membershipTxRunner: activityJoinTxRunner{server: server}}
			if err := svc.joinServerTx(context.Background(), "server", "user", "", tc.audience); err != nil {
				t.Fatal(err)
			}
			if server.addCalls != 1 || server.snapshot != tc.want {
				t.Fatalf("addCalls=%d snapshot=%t; want 1, %t", server.addCalls, server.snapshot, tc.want)
			}
		})
	}
}
