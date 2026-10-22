package services

// First unit tests for blockService (Faz B, 2026-10-21). They pin the
// existing behaviour: sentinel errors, the delete-then-recreate block row,
// the friend_remove push to the other party, and the symmetric user_block
// payload sent to BOTH sides (K-046). The sentEvent / friendSvcFixture
// helpers live in friendship_service_test.go.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type blockSvcFixture struct {
	friends *testutil.MockFriendshipRepo
	users   *testutil.MockUserRepo
	hub     *testutil.MockBroadcaster
	events  []sentEvent
	svc     BlockService
}

// newBlockSvcFixture knows users "alice" and "bob"; the friendship repo
// starts empty (GetByPair → pkg.ErrNotFound).
func newBlockSvcFixture(t *testing.T) *blockSvcFixture {
	t.Helper()
	f := &blockSvcFixture{
		friends: &testutil.MockFriendshipRepo{},
		hub:     &testutil.MockBroadcaster{},
	}
	f.users = &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			if id == "alice" || id == "bob" {
				return &models.User{ID: id, Username: id}, nil
			}
			return nil, pkg.ErrNotFound
		},
		GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
			t.Fatal("blockService must not look users up by username")
			return nil, nil
		},
	}
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) {
		f.events = append(f.events, sentEvent{to: userID, ev: e})
	}
	f.svc = NewBlockService(f.friends, f.users, f.hub)
	return f
}

func (f *blockSvcFixture) eventsOf(op string) []sentEvent {
	var out []sentEvent
	for _, e := range f.events {
		if e.ev.Op == op {
			out = append(out, e)
		}
	}
	return out
}

func (f *blockSvcFixture) setPair(fr *models.Friendship) {
	f.friends.GetByPairFn = func(_ context.Context, _, _ string) (*models.Friendship, error) {
		cp := *fr
		return &cp, nil
	}
}

func friendshipRow(userID, friendID string, status models.FriendshipStatus) *models.Friendship {
	now := time.Now().UTC()
	return &models.Friendship{ID: "fr-1", UserID: userID, FriendID: friendID, Status: status, CreatedAt: now, UpdatedAt: now}
}

// recordWrites captures Create/Delete calls on the friendship repo.
func (f *blockSvcFixture) recordWrites() (created *[]*models.Friendship, deleted *[]string) {
	c := []*models.Friendship{}
	d := []string{}
	f.friends.CreateFn = func(_ context.Context, fr *models.Friendship) error {
		cp := *fr
		c = append(c, &cp)
		return nil
	}
	f.friends.DeleteFn = func(_ context.Context, id string) error {
		d = append(d, id)
		return nil
	}
	return &c, &d
}

// assertBlockRow checks the single Create call wrote alice→bob blocked.
func assertBlockRow(t *testing.T, created []*models.Friendship) {
	t.Helper()
	if len(created) != 1 {
		t.Fatalf("Create calls = %d, want 1", len(created))
	}
	row := created[0]
	if row.UserID != "alice" || row.FriendID != "bob" || row.Status != models.FriendshipStatusBlocked || row.ID == "" {
		t.Errorf("block row = %+v, want alice→bob blocked with an id", row)
	}
}

// assertUserBlockBothSides checks user_block went to BOTH parties with the
// SAME payload: user_id = blocker, blocked_user_id = target (K-046).
func assertUserBlockBothSides(t *testing.T, f *blockSvcFixture) {
	t.Helper()
	evs := f.eventsOf(ws.OpUserBlock)
	if len(evs) != 2 {
		t.Fatalf("user_block events = %+v, want exactly two", evs)
	}
	got := map[string]bool{}
	for _, e := range evs {
		got[e.to] = true
		data, ok := e.ev.Data.(map[string]string)
		if !ok || data["user_id"] != "alice" || data["blocked_user_id"] != "bob" || len(data) != 2 {
			t.Errorf("user_block to %s data = %#v, want {user_id: alice, blocked_user_id: bob}", e.to, e.ev.Data)
		}
	}
	if !got["alice"] || !got["bob"] {
		t.Errorf("user_block recipients = %v, want both alice and bob", got)
	}
}

// ─── BlockUser ───

func TestBlockUser_Rejections(t *testing.T) {
	t.Run("self → bad request", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		if err := f.svc.BlockUser(context.Background(), "alice", "alice"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("unknown target → not found", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		if err := f.svc.BlockUser(context.Background(), "alice", "nobody"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("already blocked by me → already exists", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		f.setPair(friendshipRow("alice", "bob", models.FriendshipStatusBlocked))
		created, deleted := f.recordWrites()
		if err := f.svc.BlockUser(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrAlreadyExists) {
			t.Fatalf("err = %v, want ErrAlreadyExists", err)
		}
		if len(*created) != 0 || len(*deleted) != 0 || len(f.events) != 0 {
			t.Errorf("no writes/events expected, got created=%d deleted=%v events=%+v", len(*created), *deleted, f.events)
		}
	})

	t.Run("repo GetByPair failure passes through", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		boom := errors.New("db down")
		f.friends.GetByPairFn = func(_ context.Context, _, _ string) (*models.Friendship, error) { return nil, boom }
		if err := f.svc.BlockUser(context.Background(), "alice", "bob"); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want boom", err)
		}
	})

	t.Run("Create failure is wrapped", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		boom := errors.New("db down")
		f.friends.CreateFn = func(_ context.Context, _ *models.Friendship) error { return boom }
		err := f.svc.BlockUser(context.Background(), "alice", "bob")
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want wrapped boom", err)
		}
		if evs := f.eventsOf(ws.OpUserBlock); len(evs) != 0 {
			t.Errorf("user_block pushed although the row was not written: %+v", evs)
		}
	})
}

func TestBlockUser_NoPriorRecord(t *testing.T) {
	f := newBlockSvcFixture(t)
	created, deleted := f.recordWrites()

	if err := f.svc.BlockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if len(*deleted) != 0 {
		t.Errorf("Delete calls = %v, want none", *deleted)
	}
	assertBlockRow(t, *created)
	if evs := f.eventsOf(ws.OpFriendRemove); len(evs) != 0 {
		t.Errorf("friend_remove pushed with no prior friendship: %+v", evs)
	}
	assertUserBlockBothSides(t, f)
}

// The other side already blocked us: their row is replaced by ours (we
// become user_id) and nobody is told a friendship was removed.
func TestBlockUser_TargetBlockedMeFirst(t *testing.T) {
	f := newBlockSvcFixture(t)
	f.setPair(friendshipRow("bob", "alice", models.FriendshipStatusBlocked))
	created, deleted := f.recordWrites()

	if err := f.svc.BlockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	if len(*deleted) != 1 || (*deleted)[0] != "fr-1" {
		t.Errorf("Delete calls = %v, want [fr-1]", *deleted)
	}
	assertBlockRow(t, *created)
	if evs := f.eventsOf(ws.OpFriendRemove); len(evs) != 0 {
		t.Errorf("friend_remove must not be pushed when replacing a reverse block: %+v", evs)
	}
	assertUserBlockBothSides(t, f)
}

// A pending request or an accepted friendship (either direction) is
// deleted, the OTHER party gets friend_remove, then the block row is written.
func TestBlockUser_ReplacesExistingRelationship(t *testing.T) {
	for _, tc := range []struct {
		name             string
		userID, friendID string
		status           models.FriendshipStatus
	}{
		{"pending alice→bob", "alice", "bob", models.FriendshipStatusPending},
		{"pending bob→alice", "bob", "alice", models.FriendshipStatusPending},
		{"accepted alice→bob", "alice", "bob", models.FriendshipStatusAccepted},
		{"accepted bob→alice", "bob", "alice", models.FriendshipStatusAccepted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBlockSvcFixture(t)
			f.setPair(friendshipRow(tc.userID, tc.friendID, tc.status))
			created, deleted := f.recordWrites()

			if err := f.svc.BlockUser(context.Background(), "alice", "bob"); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
			if len(*deleted) != 1 || (*deleted)[0] != "fr-1" {
				t.Errorf("Delete calls = %v, want [fr-1]", *deleted)
			}
			assertBlockRow(t, *created)

			evs := f.eventsOf(ws.OpFriendRemove)
			if len(evs) != 1 || evs[0].to != "bob" {
				t.Fatalf("friend_remove events = %+v, want exactly one to bob", evs)
			}
			data, ok := evs[0].ev.Data.(map[string]string)
			if !ok || data["user_id"] != "alice" || len(data) != 1 {
				t.Errorf("friend_remove data = %#v, want {user_id: alice}", evs[0].ev.Data)
			}
			assertUserBlockBothSides(t, f)
		})
	}
}

// ─── UnblockUser ───

func TestUnblockUser(t *testing.T) {
	t.Run("no record → repo error passes through", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		if err := f.svc.UnblockUser(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("not blocked → bad request", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		f.setPair(friendshipRow("alice", "bob", models.FriendshipStatusAccepted))
		if err := f.svc.UnblockUser(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("only the blocker may unblock", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		f.setPair(friendshipRow("bob", "alice", models.FriendshipStatusBlocked)) // bob blocked alice
		_, deleted := f.recordWrites()
		if err := f.svc.UnblockUser(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
		if len(*deleted) != 0 || len(f.events) != 0 {
			t.Errorf("no writes/events expected, got deleted=%v events=%+v", *deleted, f.events)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		f := newBlockSvcFixture(t)
		f.setPair(friendshipRow("alice", "bob", models.FriendshipStatusBlocked))
		_, deleted := f.recordWrites()

		if err := f.svc.UnblockUser(context.Background(), "alice", "bob"); err != nil {
			t.Fatalf("UnblockUser: %v", err)
		}
		if len(*deleted) != 1 || (*deleted)[0] != "fr-1" {
			t.Errorf("Delete calls = %v, want [fr-1]", *deleted)
		}
		// Only the blocker is told; the target never learns they were blocked
		// or unblocked through this event.
		if len(f.events) != 1 {
			t.Fatalf("events = %+v, want exactly one (user_unblock to alice)", f.events)
		}
		e := f.events[0]
		if e.ev.Op != ws.OpUserUnblock || e.to != "alice" {
			t.Fatalf("event = op %s to %s, want user_unblock to alice", e.ev.Op, e.to)
		}
		data, ok := e.ev.Data.(map[string]string)
		if !ok || data["user_id"] != "alice" || data["unblocked_user_id"] != "bob" || len(data) != 2 {
			t.Errorf("user_unblock data = %#v, want {user_id: alice, unblocked_user_id: bob}", e.ev.Data)
		}
	})
}

// ─── ListBlocked / IsBlocked ───

func TestBlockService_ListBlocked_NilBecomesEmpty(t *testing.T) {
	f := newBlockSvcFixture(t)
	blocked, err := f.svc.ListBlocked(context.Background(), "alice")
	if err != nil {
		t.Fatalf("ListBlocked: %v", err)
	}
	if blocked == nil || len(blocked) != 0 {
		t.Errorf("ListBlocked = %#v, want empty non-nil slice", blocked)
	}

	boom := errors.New("db down")
	f.friends.ListBlockedFn = func(_ context.Context, _ string) ([]models.FriendshipWithUser, error) { return nil, boom }
	if _, err := f.svc.ListBlocked(context.Background(), "alice"); !errors.Is(err, boom) {
		t.Errorf("repo error: err = %v, want boom", err)
	}
}

func TestBlockService_IsBlocked_DelegatesToRepo(t *testing.T) {
	f := newBlockSvcFixture(t)
	var asked []string
	f.friends.IsBlockedFn = func(_ context.Context, a, b string) (bool, error) {
		asked = append(asked, a+"|"+b)
		return true, nil
	}
	ok, err := f.svc.IsBlocked(context.Background(), "alice", "bob")
	if err != nil || !ok {
		t.Errorf("IsBlocked = (%v, %v), want (true, nil)", ok, err)
	}
	if len(asked) != 1 || asked[0] != "alice|bob" {
		t.Errorf("repo IsBlocked calls = %v, want [alice|bob]", asked)
	}
}
