package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type atomicBlockRepoStub struct {
	*testutil.MockFriendshipRepo
	write func(context.Context, *models.Friendship) (bool, error)
}

func (s atomicBlockRepoStub) CreateBlockAtomic(ctx context.Context, row *models.Friendship) (bool, error) {
	return s.write(ctx, row)
}

func TestBlockUserAtomicEventsFollowCommit(t *testing.T) {
	for _, outcome := range []string{"failed", "new", "replaced"} {
		t.Run(outcome, func(t *testing.T) {
			f := newBlockSvcFixture(t)
			activity := &recordingGameActivityInvalidator{}
			failure := errors.New("commit failed")
			called := false
			f.friends.GetByPairFn = func(context.Context, string, string) (*models.Friendship, error) {
				t.Fatal("non-atomic fallback called")
				return nil, nil
			}
			repo := atomicBlockRepoStub{MockFriendshipRepo: f.friends, write: func(_ context.Context, row *models.Friendship) (bool, error) {
				called = true
				if len(f.events) != 0 || len(activity.calls) != 0 {
					t.Fatal("event or activity invalidation emitted before transaction finished")
				}
				if row.UserID != "alice" || row.FriendID != "bob" || row.Status != models.FriendshipStatusBlocked || row.ID == "" {
					t.Fatalf("invalid row %+v", row)
				}
				if outcome == "failed" {
					return false, failure
				}
				return outcome == "replaced", nil
			}}
			svc := NewBlockService(activity, repo, f.users, f.hub)
			err := svc.BlockUser(context.Background(), "alice", "bob")
			if !called {
				t.Fatal("atomic writer not called")
			}
			if outcome == "failed" {
				if !errors.Is(err, failure) || len(f.events) != 0 || len(activity.calls) != 0 {
					t.Fatalf("error=%v events=%+v", err, f.events)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertUserBlockBothSides(t, f)
			if len(activity.calls) != 1 || activity.calls[0] != (gameActivityInvalidationCall{kind: "relationship", a: "alice", b: "bob"}) {
				t.Fatalf("committed block activity invalidation: %+v", activity.calls)
			}
			want := 0
			if outcome == "replaced" {
				want = 1
			}
			if len(f.eventsOf(ws.OpFriendRemove)) != want {
				t.Fatalf("removal event count: %+v", f.events)
			}
		})
	}
}
