package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// A previously read high lexical ID and later low IDs share one timestamp.
// Arrival order, not random ID order, must define the retained read watermark.
func TestDMSameSecondAppendAfterReadKeepsLaterSourcesUnread(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	runner := NewDMMessageTxRunner(db.Conn)
	appendSource := func(id string) {
		t.Helper()
		err := runner.InTx(ctx, func(r *DMTxRepos) error {
			if err := r.LockChannel(ctx, channel.ID); err != nil {
				return err
			}
			if _, err := r.DM.(*sqliteDMRepo).db.ExecContext(ctx, `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,created_at) VALUES(?,?,?,'opaque source','2026-10-25 11:11:44')`, id, channel.ID, dmAlice); err != nil {
				return err
			}
			if err := r.DMRead.IncrementUnread(ctx, dmBob, channel.ID); err != nil {
				return err
			}
			n := &models.Notification{UserID: dmBob, ActorID: ptrString(dmAlice), MessageID: &id, DMChannelID: &channel.ID}
			_, err := r.Notification.CreateDMMessageIfAbsent(ctx, n)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	acknowledge := func(id *string) {
		t.Helper()
		err := runner.InTx(ctx, func(r *DMTxRepos) error {
			if err := r.LockChannel(ctx, channel.ID); err != nil {
				return err
			}
			if err := r.DMRead.MarkRead(ctx, dmBob, channel.ID, id); err != nil {
				return err
			}
			_, err := r.Notification.MarkDMMessagesRead(ctx, dmBob, channel.ID, id)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	appendSource("z-warmup")
	acknowledge(nil)
	appendSource("a-first-new")
	appendSource("b-second-new")
	appendSource("c-third-new")
	first := "a-first-new"
	acknowledge(&first)
	var unread int
	var cursor string
	if err := db.Conn.QueryRow(`SELECT unread_count,last_read_message_id FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, channel.ID).Scan(&unread, &cursor); err != nil {
		t.Fatal(err)
	}
	if unread != 2 || cursor != first {
		t.Errorf("read watermark lost same-second append order: unread=%d cursor=%q, want unread=2 cursor=%q", unread, cursor, first)
	}
	notifications := NewSQLiteNotificationRepo(wrapForRepo(db))
	count, err := notifications.CountUnread(ctx, dmBob)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("notification cutoff acknowledged newer source messages: unread=%d want2", count)
	}
}

func TestDMSourceSequenceTrustedImportTailDeletionAndRemovedReadCursor(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	for _, item := range []struct {
		id  string
		seq int64
	}{{"trusted-z", 500}, {"trusted-a", 100}} {
		if _, err := db.Conn.Exec(`INSERT INTO dm_messages(id,dm_channel_id,user_id,content,source_sequence) VALUES(?,?,?,'opaque',?)`, item.id, ch.ID, dmAlice, item.seq); err != nil {
			t.Fatal(err)
		}
	}
	first, err := dm.GetMessageByID(ctx, "trusted-z")
	if err != nil || first.SourceSequence != 500 {
		t.Fatalf("trusted import overwritten: %+v %v", first, err)
	}
	var counter int64
	if err := db.Conn.QueryRow(`SELECT last_source_sequence FROM dm_channels WHERE id=?`, ch.ID).Scan(&counter); err != nil || counter != 500 {
		t.Fatalf("import counter=%d %v", counter, err)
	}
	forged := &models.DMMessage{DMChannelID: ch.ID, UserID: dmAlice, Content: ptrString("opaque"), SourceSequence: 999999}
	if err := dm.CreateMessage(ctx, forged); err != nil {
		t.Fatal(err)
	}
	if forged.SourceSequence != 501 {
		t.Fatalf("repository caller sequence accepted: %d", forged.SourceSequence)
	}
	reads := NewSQLiteDMReadRepo(wrapForRepo(db))
	cursor := "trusted-z"
	if err := reads.MarkRead(ctx, dmBob, ch.ID, &cursor); err != nil {
		t.Fatal(err)
	}
	if err := dm.DeleteMessage(ctx, "trusted-z"); err != nil {
		t.Fatal(err)
	}
	if err := dm.DeleteMessage(ctx, forged.ID); err != nil {
		t.Fatal(err)
	}
	next := newDMMessage(t, ctx, dm, ch.ID, dmAlice, "after deleted tail")
	if next.SourceSequence != 502 {
		t.Fatalf("deleted tail sequence reused: %d", next.SourceSequence)
	}
	old := "trusted-a"
	if err := reads.MarkRead(ctx, dmBob, ch.ID, &old); err != nil {
		t.Fatal(err)
	}
	var watermark int64
	var unread int
	if err := db.Conn.QueryRow(`SELECT last_read_source_sequence,unread_count FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, ch.ID).Scan(&watermark, &unread); err != nil {
		t.Fatal(err)
	}
	if watermark != 500 || unread != 1 {
		t.Fatalf("removed cursor lost watermark: seq=%d unread=%d", watermark, unread)
	}
	if _, err := db.Conn.Exec(`UPDATE dm_messages SET source_sequence=7 WHERE id=?`, next.ID); err == nil {
		t.Fatal("immutable sequence changed")
	}
	// PostgreSQL aborts an individual implicit statement transaction above; later reads remain valid.
	if got, err := dm.GetMessageByID(ctx, next.ID); err != nil || got.SourceSequence != 502 {
		t.Fatal("sequence changed after rejected mutation")
	}
}

func TestDMSourceSequenceConcurrentDirectCreatesAndHistory(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	ch := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	done := make(chan error, 12)
	for i := 0; i < 12; i++ {
		go func() {
			msg := &models.DMMessage{DMChannelID: ch.ID, UserID: dmAlice, Content: ptrString("opaque")}
			done <- dm.CreateMessage(ctx, msg)
		}()
	}
	for i := 0; i < 12; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	page, err := dm.GetMessages(ctx, ch.ID, "", 5)
	if err != nil || len(page) != 5 {
		t.Fatalf("history=%d %v", len(page), err)
	}
	for i, m := range page {
		if m.SourceSequence != int64(12-i) {
			t.Fatalf("history not append ordered: %+v", page)
		}
	}
	older, err := dm.GetMessages(ctx, ch.ID, page[4].ID, 20)
	if err != nil || len(older) != 7 {
		t.Fatalf("before cursor dropped rows: %d %v", len(older), err)
	}
	newer, err := dm.GetMessagesAfter(ctx, ch.ID, older[0].ID, 20)
	if err != nil || len(newer) != 5 {
		t.Fatalf("after cursor=%d %v", len(newer), err)
	}
	for i, m := range newer {
		if m.SourceSequence != int64(8+i) {
			t.Fatalf("after history not append ordered: %+v", newer)
		}
	}
	search, totalFound, err := dm.SearchMessages(ctx, ch.ID, "opaque", 20, 0)
	if err != nil || totalFound != 12 || len(search) != 12 {
		t.Fatalf("search source scan count=%d/%d error=%v", len(search), totalFound, err)
	}
	for _, message := range search {
		if message.SourceSequence <= 0 {
			t.Fatal("search omitted authoritative append sequence")
		}
	}
	var distinct, total int
	if err := db.Conn.QueryRow(`SELECT COUNT(DISTINCT source_sequence),COUNT(*) FROM dm_messages WHERE dm_channel_id=?`, ch.ID).Scan(&distinct, &total); err != nil || distinct != 12 || total != 12 {
		t.Fatalf("allocation conflict distinct=%d total=%d %v", distinct, total, err)
	}
}
