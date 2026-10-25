package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestReadStateRepoMarkUnreadFrom(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	ctx := context.Background()
	messages := NewSQLiteMessageRepo(db.Conn)
	read := NewSQLiteReadStateRepo(wrapForRepo(db))
	first := newMessage(t, ctx, messages, msgChannel, msgAuthor, "first")
	anchor := newMessage(t, ctx, messages, msgChannel, msgAuthor, "anchor")
	newMessage(t, ctx, messages, msgChannel, msgAuthor, "third")
	if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE id=?`, "2026-01-01 10:00:00", first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE id=?`, "2026-01-01 10:01:00", anchor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE content='third'`, "2026-01-01 10:02:00"); err != nil {
		t.Fatal(err)
	}

	count, err := read.MarkUnreadFrom(ctx, msgSecondUser, msgChannel, anchor.ID)
	if err != nil {
		t.Fatalf("MarkUnreadFrom: %v", err)
	}
	if count != 2 {
		t.Fatalf("count=%d want 2", count)
	}
	var last string
	if err := db.Conn.QueryRow(`SELECT last_read_message_id FROM channel_reads WHERE user_id=? AND channel_id=?`, msgSecondUser, msgChannel).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if last != first.ID {
		t.Fatalf("last=%q want %q", last, first.ID)
	}
	if _, err := read.MarkUnreadFrom(ctx, msgSecondUser, msgOtherChannel, anchor.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-channel err=%v want not found", err)
	}
}

func TestReadStateVoiceUnreadAnchorExcludesOwnMessagesAndMarkAllReadClearsIt(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO channels(id,name,type,server_id) VALUES('voice-read','Voice','voice','srv-1'),('audit-read','Audit','audit','srv-1')`); err != nil {
		t.Fatal(err)
	}
	messages := NewSQLiteMessageRepo(db.Conn)
	read := NewSQLiteReadStateRepo(wrapForRepo(db))
	before := newMessage(t, ctx, messages, "voice-read", msgAuthor, "before anchor")
	unread := newMessage(t, ctx, messages, "voice-read", msgAuthor, "unread voice message")
	own := newMessage(t, ctx, messages, "voice-read", msgSecondUser, "own voice message")
	newMessage(t, ctx, messages, "audit-read", msgAuthor, "audit is not a message channel")
	for id, stamp := range map[string]string{
		before.ID: "2026-01-01 10:00:00",
		unread.ID: "2026-01-01 10:01:00",
		own.ID:    "2026-01-01 10:02:00",
	} {
		if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE id=?`, stamp, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := read.Upsert(ctx, msgSecondUser, "voice-read", before.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE channel_reads SET unread_count=1 WHERE user_id=? AND channel_id=?`, msgSecondUser, "voice-read"); err != nil {
		t.Fatal(err)
	}
	unreads, err := read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(unreads) != 1 || unreads[0].ChannelID != "voice-read" || unreads[0].UnreadCount != 1 || unreads[0].OldestUnreadMessageID == nil || *unreads[0].OldestUnreadMessageID != unread.ID {
		t.Fatalf("voice unreads=%+v; want one unread voice message anchored at %s, excluding own %s", unreads, unread.ID, own.ID)
	}
	if err := read.MarkAllRead(ctx, msgSecondUser, "srv-1"); err != nil {
		t.Fatal(err)
	}
	var lastRead string
	var unreadCount int
	if err := db.Conn.QueryRow(`SELECT last_read_message_id,unread_count FROM channel_reads WHERE user_id=? AND channel_id='voice-read'`, msgSecondUser).Scan(&lastRead, &unreadCount); err != nil {
		t.Fatal(err)
	}
	if lastRead != own.ID || unreadCount != 0 {
		t.Fatalf("voice read state last=%q count=%d, want latest=%q and zero", lastRead, unreadCount, own.ID)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM channel_reads WHERE user_id=? AND channel_id='audit-read'`, msgSecondUser); got != 0 {
		t.Fatalf("mark-all-read wrote state for audit channel: %d rows", got)
	}
	unreads, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(unreads) != 0 {
		t.Fatalf("unreads after mark-all-read=%+v err=%v", unreads, err)
	}
}

func TestDMReadRepoMarkUnreadFrom(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	dms := NewSQLiteDMRepo(db.Conn)
	read := NewSQLiteDMReadRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, dms, dmAlice, dmBob, models.DMStatusAccepted)
	first := newDMMessage(t, ctx, dms, channel.ID, dmAlice, "first")
	anchor := newDMMessage(t, ctx, dms, channel.ID, dmAlice, "anchor")
	newDMMessage(t, ctx, dms, channel.ID, dmAlice, "third")
	_, _ = db.Conn.Exec(`UPDATE dm_messages SET created_at=? WHERE id=?`, "2026-01-01 10:00:00", first.ID)
	_, _ = db.Conn.Exec(`UPDATE dm_messages SET created_at=? WHERE id=?`, "2026-01-01 10:01:00", anchor.ID)
	_, _ = db.Conn.Exec(`UPDATE dm_messages SET created_at=? WHERE content='third'`, "2026-01-01 10:02:00")

	count, err := read.MarkUnreadFrom(ctx, dmBob, channel.ID, anchor.ID)
	if err != nil {
		t.Fatalf("MarkUnreadFrom: %v", err)
	}
	if count != 2 {
		t.Fatalf("count=%d want 2", count)
	}
	var last string
	if err := db.Conn.QueryRow(`SELECT last_read_message_id FROM dm_reads WHERE user_id=? AND dm_channel_id=?`, dmBob, channel.ID).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if last != first.ID {
		t.Fatalf("last=%q want %q", last, first.ID)
	}
}
