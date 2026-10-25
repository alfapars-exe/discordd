package repository

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestAcceptPendingDMChecksCurrentBlockAndStatus(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		db := newTestDB(t)
		seedDMUsers(t, db)
		ctx := context.Background()
		dm := NewSQLiteDMRepo(wrapForRepo(db))
		ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusPending)
		friends := NewSQLiteFriendshipRepo(db.Conn)
		a, b := dmAlice, dmBob
		if reverse {
			a, b = b, a
		}
		now := time.Now().UTC()
		if err := friends.Create(ctx, &models.Friendship{ID: "block", UserID: a, FriendID: b, Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		writer := dm.(PendingDMAccepter)
		if changed, err := writer.AcceptPendingUnblocked(ctx, ch.ID); err != nil || changed {
			t.Fatalf("blocked request changed=%v err=%v", changed, err)
		}
		if row, err := dm.GetChannelByID(ctx, ch.ID); err != nil || row.Status != models.DMStatusPending {
			t.Fatalf("pending lost: %+v %v", row, err)
		}
		if err := friends.Delete(ctx, "block"); err != nil {
			t.Fatal(err)
		}
		if changed, err := writer.AcceptPendingUnblocked(ctx, ch.ID); err != nil || !changed {
			t.Fatalf("unblocked request changed=%v err=%v", changed, err)
		}
		if changed, err := writer.AcceptPendingUnblocked(ctx, ch.ID); err != nil || changed {
			t.Fatalf("duplicate accepted changed=%v err=%v", changed, err)
		}
		if changed, err := writer.AcceptPendingUnblocked(ctx, "missing"); err != nil || changed {
			t.Fatalf("missing request changed=%v err=%v", changed, err)
		}
	}
}

func TestPostgresPendingDMAwaitsBlockCommit(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires isolated PostgreSQL row-lock fixture")
	}
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusPending)
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE dm_channels SET status = status WHERE id = ?`, ch.ID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err = tx.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status,created_at,updated_at) VALUES(?,?,?,'blocked',?,?)`, "held-block", dmBob, dmAlice, now, now); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		changed bool
		err     error
	}
	done := make(chan outcome, 1)
	started := make(chan struct{})
	go func() {
		close(started)
		changed, err := dm.(PendingDMAccepter).AcceptPendingUnblocked(ctx, ch.ID)
		done <- outcome{changed, err}
	}()
	<-started
	select {
	case result := <-done:
		t.Fatalf("accept did not wait for block: %+v", result)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result.err != nil || result.changed {
			t.Fatalf("accept ignored newly committed block: %+v", result)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	row, err := dm.GetChannelByID(ctx, ch.ID)
	if err != nil || row.Status != models.DMStatusPending {
		t.Fatalf("pending lost: %+v %v", row, err)
	}
}
