package repository

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestDMCreateUnblockedRejectsEitherBlockAndPreservesHistory(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(map[bool]string{false: "forward", true: "reverse"}[reverse], func(t *testing.T) {
			db := newTestDB(t)
			seedDMUsers(t, db)
			ctx := context.Background()
			repo := NewSQLiteDMRepo(wrapForRepo(db))
			writer := repo.(UnblockedDMChannelCreator)
			a, b := dmAlice, dmBob
			if reverse {
				a, b = b, a
			}
			now := time.Now().UTC()
			friend := NewSQLiteFriendshipRepo(wrapForRepo(db))
			block := &models.Friendship{ID: "block", UserID: a, FriendID: b, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now}
			if _, err := friend.(AtomicBlockWriter).CreateBlockAtomic(ctx, block); err != nil {
				t.Fatal(err)
			}
			ch := &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted}
			if created, err := writer.CreateChannelUnblocked(ctx, ch); created || !errors.Is(err, pkg.ErrForbidden) || ch.ID != "" {
				t.Fatalf("blocked created=%v err=%v ch=%#v", created, err, ch)
			}
			if countRows(t, db, `SELECT COUNT(*) FROM dm_channels`) != 0 {
				t.Fatal("blocked INSERT retained")
			}
			if err := friend.Delete(ctx, "block"); err != nil {
				t.Fatal(err)
			}
			if created, err := writer.CreateChannelUnblocked(ctx, ch); err != nil || !created {
				t.Fatalf("unblocked created=%v err=%v", created, err)
			}
			if _, err := friend.(AtomicBlockWriter).CreateBlockAtomic(ctx, block); err != nil {
				t.Fatal(err)
			}
			other := &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted}
			if created, err := writer.CreateChannelUnblocked(ctx, other); err != nil || created || other.ID != ch.ID {
				t.Fatalf("history created=%v err=%v ch=%#v", created, err, other)
			}
		})
	}
}

func TestDMCreateUnblockedConcurrentDuplicateReturnsOneNewChannel(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	writer := NewSQLiteDMRepo(wrapForRepo(db)).(UnblockedDMChannelCreator)
	type outcome struct {
		created bool
		id      string
		err     error
	}
	done := make(chan outcome, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ch := &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted}
			created, err := writer.CreateChannelUnblocked(context.Background(), ch)
			done <- outcome{created, ch.ID, err}
		}()
	}
	close(start)
	wg.Wait()
	close(done)
	created := 0
	id := ""
	for result := range done {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.created {
			created++
		}
		if id != "" && id != result.id {
			t.Fatal("different history IDs")
		}
		id = result.id
	}
	if created != 1 || id == "" || countRows(t, db, `SELECT COUNT(*) FROM dm_channels`) != 1 {
		t.Fatalf("created=%d id=%q", created, id)
	}
}

func TestDMCreateUnblockedAwaitsConcurrentBlockCommit(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := lockDMCreationPair(ctx, tx, dmBob, dmAlice, database.IsPostgres(db.Conn)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('in-flight-block',?,?,'blocked')`, dmBob, dmAlice); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := NewSQLiteDMRepo(wrapForRepo(db)).(UnblockedDMChannelCreator).CreateChannelUnblocked(ctx, &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted})
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("create did not await block transaction: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("newly committed block ignored: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if countRows(t, db, `SELECT COUNT(*) FROM dm_channels`) != 0 {
		t.Fatal("concurrent blocked INSERT retained")
	}
}

func TestAtomicBlockAwaitsConcurrentDMCreationCommit(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := lockDMCreationPair(ctx, tx, dmAlice, dmBob, database.IsPostgres(db.Conn)); err != nil {
		t.Fatal(err)
	}
	ch := &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted}
	if err := (&sqliteDMRepo{db: tx}).CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		now := time.Now().UTC()
		_, err := NewSQLiteFriendshipRepo(wrapForRepo(db)).(AtomicBlockWriter).CreateBlockAtomic(ctx, &models.Friendship{ID: "after-create", UserID: dmBob, FriendID: dmAlice, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now})
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("block did not await creation transaction: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if countRows(t, db, `SELECT COUNT(*) FROM dm_channels`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM friendships WHERE status='blocked'`) != 1 {
		t.Fatal("creation-first history or subsequent block lost")
	}
}
