package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestDMMessageNotification_DedupCutoffAndRollback(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	notifications := NewSQLiteNotificationRepo(wrapForRepo(db))
	reads := NewSQLiteDMReadRepo(wrapForRepo(db))
	messages := []*models.DMMessage{}
	for i := 0; i < 3; i++ {
		m := newDMMessage(t, ctx, dm, ch.ID, dmAlice, "private body must not be copied")
		messages = append(messages, m)
		if _, err := db.Conn.Exec(`UPDATE dm_messages SET created_at=? WHERE id=?`, []string{"2026-01-01 00:00:01", "2026-01-01 00:00:02", "2026-01-01 00:00:03"}[i], m.ID); err != nil {
			t.Fatal(err)
		}
		if err := reads.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			t.Fatal(err)
		}
		n := &models.Notification{UserID: dmBob, ActorID: &m.UserID, MessageID: &m.ID, DMChannelID: &ch.ID, Payload: json.RawMessage(`{"body":"must be replaced"}`)}
		created, err := notifications.CreateDMMessageIfAbsent(ctx, n)
		if err != nil || !created {
			t.Fatalf("create=(%v,%v)", created, err)
		}
		if string(n.Payload) != `{"action":"incoming_message","source":"dm"}` || n.Kind != models.NotificationKindSystem {
			t.Fatalf("unexpected metadata: %+v", n)
		}
		id := n.ID
		created, err = notifications.CreateDMMessageIfAbsent(ctx, n)
		if err != nil || created || n.ID != id {
			t.Fatalf("duplicate=(%v,%v)", created, err)
		}
	}
	runner := NewDMMessageTxRunner(db.Conn)
	acknowledge := func(cursor *string) error {
		return runner.InTx(ctx, func(r *DMTxRepos) error {
			if err := r.LockChannel(ctx, ch.ID); err != nil {
				return err
			}
			if err := r.DMRead.MarkRead(ctx, dmBob, ch.ID, cursor); err != nil {
				return err
			}
			stored, remaining, err := r.ReadState(ctx, dmBob, ch.ID)
			if err != nil {
				return err
			}
			if stored == nil || remaining < 0 {
				return errors.New("stored read state missing after acknowledgement")
			}
			_, err = r.Notification.MarkDMMessagesRead(ctx, dmBob, ch.ID, cursor)
			return err
		})
	}
	if err := acknowledge(&messages[0].ID); err != nil {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, ch.ID); count != 2 {
		t.Fatalf("remaining unread=%d", count)
	}
	if count, err := notifications.CountUnread(ctx, dmBob); err != nil || count != 2 {
		t.Fatalf("remaining notifications=(%d,%v)", count, err)
	}
	wrong := newDMChannel(t, ctx, dm, dmAlice, dmCarol, models.DMStatusAccepted)
	foreign := newDMMessage(t, ctx, dm, wrong.ID, dmAlice, "foreign")
	if err := acknowledge(&foreign.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-conversation cursor=%v", err)
	}
	missing := "deleted-source"
	if err := acknowledge(&missing); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("missing cursor=%v", err)
	}
	if err := acknowledge(&messages[1].ID); err != nil {
		t.Fatal(err)
	}
	if err := acknowledge(&messages[0].ID); err != nil {
		t.Fatal(err)
	}
	if count, err := notifications.CountUnread(ctx, dmBob); err != nil || count != 1 {
		t.Fatalf("late read regressed notifications=(%d,%v)", count, err)
	}
	rollback := errors.New("rollback")
	if err := runner.InTx(ctx, func(r *DMTxRepos) error {
		if err := r.LockChannel(ctx, ch.ID); err != nil {
			return err
		}
		if err := r.DMRead.MarkRead(ctx, dmBob, ch.ID, nil); err != nil {
			return err
		}
		if _, err := r.Notification.MarkDMMessagesRead(ctx, dmBob, ch.ID, nil); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if count, err := notifications.CountUnread(ctx, dmBob); err != nil || count != 1 {
		t.Fatalf("rollback changed notifications=(%d,%v)", count, err)
	}
	if err := acknowledge(nil); err != nil {
		t.Fatal(err)
	}
	if count, err := notifications.CountUnread(ctx, dmBob); err != nil || count != 0 {
		t.Fatalf("nil read notifications=(%d,%v)", count, err)
	}
	if err := acknowledge(&messages[0].ID); err != nil {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, ch.ID); count != 0 {
		t.Fatalf("late acknowledgement after bodyless read resurrected=%d", count)
	}
	// A source committed after the serialized cutoff starts unread independently.
	if err := runner.InTx(ctx, func(r *DMTxRepos) error {
		if err := r.LockChannel(ctx, ch.ID); err != nil {
			return err
		}
		m := &models.DMMessage{DMChannelID: ch.ID, UserID: dmAlice, Content: strPtr("after read")}
		if err := r.DM.CreateMessage(ctx, m); err != nil {
			return err
		}
		if err := r.DMRead.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			return err
		}
		_, err := r.Notification.CreateDMMessageIfAbsent(ctx, &models.Notification{UserID: dmBob, ActorID: &m.UserID, MessageID: &m.ID, DMChannelID: &ch.ID})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, ch.ID); count != 1 {
		t.Fatalf("post-cutoff unread=%d", count)
	}
	if count, err := notifications.CountUnread(ctx, dmBob); err != nil || count != 1 {
		t.Fatalf("post-cutoff notifications=(%d,%v)", count, err)
	}
}

func TestDMMessageNotification_PendingSelfAndUnrelatedFailClosed(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusPending)
	m := newDMMessage(t, ctx, dm, ch.ID, dmAlice, "pending")
	for _, recipient := range []string{dmBob, dmCarol, dmAlice} {
		n := &models.Notification{UserID: recipient, ActorID: &m.UserID, MessageID: &m.ID, DMChannelID: &ch.ID}
		created, err := repo.CreateDMMessageIfAbsent(ctx, n)
		if created || (recipient != dmAlice && err != nil) {
			t.Fatalf("recipient=%s created=%v err=%v", recipient, created, err)
		}
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM notifications`); count != 0 {
		t.Fatalf("unexpected rows=%d", count)
	}
}

func TestDMMessageNotification_ConcurrentDeliveryAndSourceRollback(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	m := newDMMessage(t, ctx, dm, ch.ID, dmAlice, "encrypted source metadata only")
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := &models.Notification{UserID: dmBob, ActorID: &m.UserID, MessageID: &m.ID, DMChannelID: &ch.ID}
			created, err := repo.CreateDMMessageIfAbsent(ctx, n)
			results <- created
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	created := 0
	for value := range results {
		if value {
			created++
		}
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if created != 1 {
		t.Fatalf("concurrent creates=%d", created)
	}
	runner := NewDMMessageTxRunner(db.Conn)
	rollback := errors.New("rollback after notification")
	var rolledID string
	err := runner.InTx(ctx, func(r *DMTxRepos) error {
		if err := r.LockChannel(ctx, ch.ID); err != nil {
			return err
		}
		message := &models.DMMessage{DMChannelID: ch.ID, UserID: dmAlice, Content: strPtr("rollback source")}
		if err := r.DM.CreateMessage(ctx, message); err != nil {
			return err
		}
		rolledID = message.ID
		if err := r.DMRead.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			return err
		}
		created, err := r.Notification.CreateDMMessageIfAbsent(ctx, &models.Notification{UserID: dmBob, ActorID: &message.UserID, MessageID: &message.ID, DMChannelID: &ch.ID})
		if err != nil {
			return err
		}
		if !created {
			return errors.New("transaction notification not inserted")
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, rolledID); count != 0 {
		t.Fatalf("rolled back notice survived: %d", count)
	}
	if count := countRows(t, db, `SELECT COUNT(*) FROM dm_messages WHERE id=?`, rolledID); count != 0 {
		t.Fatalf("rolled back source survived: %d", count)
	}
}

func TestDMMessageNotification_SameTimestampCutoffUsesSourceSequence(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	messages := []*models.DMMessage{newDMMessage(t, ctx, dm, ch.ID, dmAlice, "first"), newDMMessage(t, ctx, dm, ch.ID, dmAlice, "second")}
	for _, m := range messages {
		if _, err := db.Conn.Exec(`UPDATE dm_messages SET created_at='2026-01-01 00:00:01' WHERE id=?`, m.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.CreateDMMessageIfAbsent(ctx, &models.Notification{UserID: dmBob, ActorID: &m.UserID, DMChannelID: &ch.ID, MessageID: &m.ID}); err != nil {
			t.Fatal(err)
		}
	}
	err := NewDMMessageTxRunner(db.Conn).InTx(ctx, func(r *DMTxRepos) error {
		if err := r.LockChannel(ctx, ch.ID); err != nil {
			return err
		}
		if err := r.DMRead.MarkRead(ctx, dmBob, ch.ID, &messages[0].ID); err != nil {
			return err
		}
		ids, err := r.Notification.MarkDMMessagesRead(ctx, dmBob, ch.ID, &messages[0].ID)
		if err == nil && len(ids) != 1 {
			return fmt.Errorf("acknowledged %d sources at same timestamp", len(ids))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if count := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, ch.ID); count != 1 {
		t.Fatalf("same-time remaining=%d", count)
	}
	if count, err := repo.CountUnread(ctx, dmBob); err != nil || count != 1 {
		t.Fatalf("same-time notices=(%d,%v)", count, err)
	}
}
