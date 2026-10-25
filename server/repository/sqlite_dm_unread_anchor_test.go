package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestDMListOldestUnreadAnchorUsesReaderCursorAndRepairsDeletedCursor(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	reads := NewSQLiteDMReadRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, dm, dmAlice, dmBob, models.DMStatusAccepted)
	insert := func(id, author, created string) {
		t.Helper()
		if _, err := db.Conn.ExecContext(ctx, `INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES(?,?,?,'body')`, id, channel.ID, author); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.ExecContext(ctx, `UPDATE dm_messages SET created_at=? WHERE id=?`, created, id); err != nil {
			t.Fatal(err)
		}
	}
	insert("a-own-before", dmAlice, "2026-01-01 10:00:00")
	insert("b-incoming-before", dmBob, "2026-01-01 10:00:00")
	insert("c-own-cursor", dmAlice, "2026-01-01 10:00:00")
	insert("d-incoming-first", dmBob, "2026-01-01 10:00:00")
	insert("e-own-after", dmAlice, "2026-01-01 10:00:00")
	insert("f-incoming-second", dmBob, "2026-01-01 10:00:00")
	cursor := "c-own-cursor"
	if err := reads.MarkRead(ctx, dmAlice, channel.ID, &cursor); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE dm_reads SET unread_count=2 WHERE user_id=? AND dm_channel_id=?`, dmAlice, channel.ID); err != nil {
		t.Fatal(err)
	}
	list, err := dm.ListChannels(ctx, dmAlice)
	if err != nil || len(list) != 1 {
		t.Fatalf("list channels: rows=%d err=%v", len(list), err)
	}
	if list[0].UnreadCount != 2 || list[0].OldestUnreadMessageID == nil || *list[0].OldestUnreadMessageID != "d-incoming-first" {
		t.Fatalf("unread summary=%+v, want first incoming after cursor", list[0])
	}
	if err := dm.DeleteMessage(ctx, cursor); err != nil {
		t.Fatal(err)
	}
	list, err = dm.ListChannels(ctx, dmAlice)
	if err != nil || len(list) != 1 {
		t.Fatalf("list after deleting cursor: rows=%d err=%v", len(list), err)
	}
	if list[0].UnreadCount != 2 || list[0].OldestUnreadMessageID == nil || *list[0].OldestUnreadMessageID != "d-incoming-first" {
		t.Fatalf("deleted cursor was not repaired: %+v", list[0])
	}
	if err := dm.DeleteMessage(ctx, "d-incoming-first"); err != nil {
		t.Fatal(err)
	}
	list, err = dm.ListChannels(ctx, dmAlice)
	if err != nil || list[0].UnreadCount != 1 || list[0].OldestUnreadMessageID == nil || *list[0].OldestUnreadMessageID != "f-incoming-second" {
		t.Fatalf("unread deletion summary=%+v err=%v", list[0], err)
	}
	if err := reads.MarkRead(ctx, dmAlice, channel.ID, nil); err != nil {
		t.Fatal(err)
	}
	list, err = dm.ListChannels(ctx, dmAlice)
	if err != nil || list[0].UnreadCount != 0 || list[0].OldestUnreadMessageID != nil {
		t.Fatalf("read channel still exposed anchor: %+v err=%v", list[0], err)
	}
}
