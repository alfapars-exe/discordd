package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestDMMessageNotification_ReadBacklogAcknowledgesAllWithBoundedIDs(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := 0; i < 601; i++ {
		id := fmt.Sprintf("backlog-source-%04d", i)
		if _, err := tx.ExecContext(ctx, `INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES(?,?,?,?)`, id, ch.ID, dmAlice, "source"); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,actor_id,message_id,dm_channel_id,payload) VALUES(?,?,'system',?,?,?,?)`, "notice-"+id, dmBob, dmAlice, id, ch.ID, `{"action":"incoming_message","source":"dm"}`); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	err = NewDMMessageTxRunner(db.Conn).InTx(ctx, func(r *DMTxRepos) error {
		if err := r.LockChannel(ctx, ch.ID); err != nil {
			return err
		}
		if err := r.DMRead.MarkRead(ctx, dmBob, ch.ID, nil); err != nil {
			return err
		}
		ids, err := r.Notification.MarkDMMessagesRead(ctx, dmBob, ch.ID, nil)
		if err != nil {
			return err
		}
		if len(ids) != 513 {
			return fmt.Errorf("read returned %d IDs, expected bounded overflow marker", len(ids))
		}
		cursor, count, err := r.ReadState(ctx, dmBob, ch.ID)
		if err != nil {
			return err
		}
		if cursor == nil || count != 0 {
			return fmt.Errorf("incorrect stored read state: cursor=%v count=%d", cursor, count)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL`, dmBob); count != 0 {
		t.Fatalf("bounded response left %d matching notifications unread", count)
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NOT NULL`, dmBob); count != 601 {
		t.Fatalf("acknowledged %d, expected all601", count)
	}
}
