package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestFriendshipIndependentDirectedBlocks(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteFriendshipRepo(db.Conn)
	now := time.Now().UTC()
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, pair := range [][2]string{{dmAlice, dmBob}, {dmBob, dmAlice}} {
		id := []string{"block-a", "block-b"}[i]
		go func(id string, pair [2]string) {
			<-start
			results <- repo.Create(ctx, &models.Friendship{ID: id, UserID: pair[0], FriendID: pair[1], Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
		}(id, pair)
	}
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	for _, pair := range [][2]string{{dmAlice, dmBob}, {dmBob, dmAlice}} {
		row, err := repo.GetByPair(ctx, pair[0], pair[1])
		if err != nil || row.UserID != pair[0] {
			t.Fatalf("owner selection: row=%+v err=%v", row, err)
		}
	}
	if err := repo.Delete(ctx, "block-b"); err != nil {
		t.Fatal(err)
	}
	blocked, err := repo.IsBlocked(ctx, dmAlice, dmBob)
	if err != nil || !blocked {
		t.Fatalf("reverse unblock erased original: blocked=%v err=%v", blocked, err)
	}
	rows, err := repo.ListBlocked(ctx, dmAlice)
	if err != nil || len(rows) != 1 {
		t.Fatalf("owner list lost block: rows=%+v err=%v", rows, err)
	}
	row, err := repo.GetByPair(ctx, dmBob, dmAlice)
	if err != nil || row.UserID != dmAlice {
		t.Fatalf("remaining owner: row=%+v err=%v", row, err)
	}
}

func TestListBlockedUserIDsReturnsEitherDirectionInBoundedBulkLookup(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteFriendshipRepo(db.Conn).(ProfileAudienceBlockReader)
	now := time.Now().UTC()
	for _, f := range []*models.Friendship{
		{ID: "target-blocks-bob", UserID: dmAlice, FriendID: dmBob, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now},
		{ID: "carol-blocks-target", UserID: dmCarol, FriendID: dmAlice, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now},
	} {
		if err := NewSQLiteFriendshipRepo(db.Conn).Create(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	blocked, err := repo.ListBlockedUserIDs(ctx, dmAlice, []string{dmBob, dmCarol, "dm-dave"})
	if err != nil {
		t.Fatal(err)
	}
	if !blocked[dmBob] || !blocked[dmCarol] || blocked["dm-dave"] {
		t.Fatalf("blocked candidates = %v", blocked)
	}
}

func TestAtomicBlockWinsConcurrentPendingAcceptance(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteFriendshipRepo(wrapForRepo(db))
	now := time.Now().UTC()
	if err := repo.Create(ctx, &models.Friendship{ID: "pending", UserID: dmAlice, FriendID: dmBob, Status: models.FriendshipStatusPending, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	acceptResult := make(chan error, 1)
	blockResult := make(chan error, 1)
	go func() { <-start; acceptResult <- repo.UpdateStatus(ctx, "pending", models.FriendshipStatusAccepted) }()
	go func() {
		<-start
		_, err := repo.(AtomicBlockWriter).CreateBlockAtomic(ctx, &models.Friendship{ID: "new-block", UserID: dmBob, FriendID: dmAlice, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
		blockResult <- err
	}()
	close(start)
	if err := <-blockResult; err != nil {
		t.Fatal(err)
	}
	if err := <-acceptResult; err != nil && !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal(err)
	}
	row, err := repo.GetByPair(ctx, dmAlice, dmBob)
	if err != nil || row.Status != models.FriendshipStatusBlocked || row.UserID != dmBob {
		t.Fatalf("stale acceptance won: %+v %v", row, err)
	}
	for _, owner := range []string{dmAlice, dmBob} {
		friends, err := repo.ListFriends(ctx, owner)
		if err != nil || len(friends) != 0 {
			t.Fatalf("accepted relationship survived: %+v %v", friends, err)
		}
	}
}

func TestAtomicBlockRollsBackRelationshipOnInsertFailure(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteFriendshipRepo(wrapForRepo(db))
	now := time.Now().UTC()
	original := &models.Friendship{ID: "original", UserID: dmAlice, FriendID: dmBob, Status: models.FriendshipStatusAccepted, CreatedAt: now, UpdatedAt: now}
	if err := repo.Create(ctx, original); err != nil {
		t.Fatal(err)
	}
	// An existing reverse row owns this primary key. Insertion must fail after
	// deleting the accepted relationship and roll that deletion back.
	reverse := &models.Friendship{ID: "collision", UserID: dmBob, FriendID: dmAlice, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now}
	if err := repo.Create(ctx, reverse); err != nil {
		t.Fatal(err)
	}
	bad := *original
	bad.ID = reverse.ID
	bad.Status = models.FriendshipStatusBlocked
	if _, err := repo.(AtomicBlockWriter).CreateBlockAtomic(ctx, &bad); err == nil {
		t.Fatal("primary-key collision accepted")
	}
	if row, err := repo.GetByID(ctx, original.ID); err != nil || row.Status != models.FriendshipStatusAccepted {
		t.Fatalf("relationship changed: %+v %v", row, err)
	}
	block := *original
	block.ID = "block"
	block.Status = models.FriendshipStatusBlocked
	removed, err := repo.(AtomicBlockWriter).CreateBlockAtomic(ctx, &block)
	if err != nil || !removed {
		t.Fatalf("atomic replacement removed=%v err=%v", removed, err)
	}
	if row, err := repo.GetByPair(ctx, dmAlice, dmBob); err != nil || row.Status != models.FriendshipStatusBlocked {
		t.Fatalf("block missing: %+v %v", row, err)
	}
}

func TestAtomicBlockConcurrentReplacement(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteFriendshipRepo(wrapForRepo(db))
	now := time.Now().UTC()
	if err := repo.Create(ctx, &models.Friendship{ID: "accepted", UserID: dmAlice, FriendID: dmBob, Status: models.FriendshipStatusAccepted, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		removed bool
		err     error
	}
	start := make(chan struct{})
	results := make(chan outcome, 2)
	for i, pair := range [][2]string{{dmAlice, dmBob}, {dmBob, dmAlice}} {
		go func(id string, pair [2]string) {
			<-start
			removed, err := repo.(AtomicBlockWriter).CreateBlockAtomic(ctx, &models.Friendship{ID: id, UserID: pair[0], FriendID: pair[1], Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
			results <- outcome{removed, err}
		}([]string{"a", "b"}[i], pair)
	}
	close(start)
	removals := 0
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.removed {
			removals++
		}
	}
	if removals != 1 {
		t.Fatalf("relationship removed %d times", removals)
	}
	for _, owner := range []string{dmAlice, dmBob} {
		rows, err := repo.ListBlocked(ctx, owner)
		if err != nil || len(rows) != 1 {
			t.Fatalf("owner=%s rows=%+v err=%v", owner, rows, err)
		}
		friends, err := repo.ListFriends(ctx, owner)
		if err != nil || len(friends) != 0 {
			t.Fatalf("accepted friendship survived: %+v %v", friends, err)
		}
	}
}
