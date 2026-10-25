package repository

import (
	"context"
	"errors"
	"sort"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestReadStateUnreadMentions(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	ctx := context.Background()
	messages := NewSQLiteMessageRepo(db.Conn)
	mentions := NewSQLiteMentionRepo(db.Conn)
	roles := NewSQLiteRoleMentionRepo(db.Conn)
	read := NewSQLiteReadStateRepo(wrapForRepo(db))
	first := newMessage(t, ctx, messages, msgChannel, msgAuthor, "read direct")
	second := newMessage(t, ctx, messages, msgChannel, msgAuthor, "direct and role")
	third := newMessage(t, ctx, messages, msgChannel, msgAuthor, "role only")
	own := newMessage(t, ctx, messages, msgChannel, msgSecondUser, "self mention")
	for index, message := range []*models.Message{first, second, third, own} {
		stamp := []string{"2026-01-01 10:00:00", "2026-01-01 10:01:00", "2026-01-01 10:02:00", "2026-01-01 10:03:00"}[index]
		if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE id=?`, stamp, message.ID); err != nil {
			t.Fatal(err)
		}
	}
	for _, message := range []*models.Message{first, second, own} {
		if err := mentions.SaveMentions(ctx, message.ID, []string{msgSecondUser}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Conn.Exec(`INSERT INTO roles(id,name,server_id,is_default) VALUES ('mention-role','Readers','srv-1',0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id) VALUES (?,'mention-role')`, msgSecondUser); err != nil {
		t.Fatal(err)
	}
	for _, message := range []*models.Message{second, third} {
		if err := roles.SaveRoleMentions(ctx, message.ID, []string{"mention-role"}); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want int) {
		t.Helper()
		rows, err := read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
		if err != nil {
			t.Fatal(err)
		}
		got := 0
		for _, row := range rows {
			if row.ChannelID == msgChannel {
				got = row.MentionCount
			}
		}
		if got != want {
			t.Fatalf("mention_count=%d want %d; rows=%+v", got, want, rows)
		}
	}
	check(3) // not limited by a notification page; direct+role counts once
	if err := read.Upsert(ctx, msgSecondUser, msgChannel, first.ID); err != nil {
		t.Fatal(err)
	}
	if err := read.IncrementUnreadCounts(ctx, msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	check(2)
	if _, err := db.Conn.Exec(`DELETE FROM user_roles WHERE user_id=? AND role_id='mention-role'`, msgSecondUser); err != nil {
		t.Fatal(err)
	}
	check(1) // revoked role no longer qualifies; direct mention still does
	if err := mentions.DeleteByMessageID(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	check(0) // edited-away mentions are not stale notification rows
	if _, err := db.Conn.Exec(`UPDATE roles SET is_default=1 WHERE id='mention-role'`); err != nil {
		t.Fatal(err)
	}
	check(2) // default/everyone role applies without an explicit user_roles row
	if err := read.Upsert(ctx, msgSecondUser, msgChannel, own.ID); err != nil {
		t.Fatal(err)
	}
	check(0)
}

func TestReadStateUnreadMentionsNotNotificationPageLimited(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	ctx := context.Background()
	messages := NewSQLiteMessageRepo(db.Conn)
	mentions := NewSQLiteMentionRepo(db.Conn)
	read := NewSQLiteReadStateRepo(wrapForRepo(db))
	ids := make([]string, 0, 60)
	for i := 0; i < 60; i++ {
		m := newMessage(t, ctx, messages, msgChannel, msgAuthor, "mention")
		if _, err := db.Conn.Exec(`UPDATE messages SET created_at=? WHERE id=?`, "2026-01-01 10:00:00", m.ID); err != nil {
			t.Fatal(err)
		}
		if err := mentions.SaveMentions(ctx, m.ID, []string{msgSecondUser}); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.ID)
	}
	rows, err := read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].MentionCount != 60 {
		t.Fatalf("full mention counts: %+v, %v", rows, err)
	}
	sort.Strings(ids)
	if err := read.Upsert(ctx, msgSecondUser, msgChannel, ids[30]); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 29; i++ {
		if err := read.IncrementUnreadCounts(ctx, msgChannel, msgAuthor); err != nil {
			t.Fatal(err)
		}
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].MentionCount != 29 {
		t.Fatalf("timestamp/id boundary: %+v, %v", rows, err)
	}
	runner := NewMessageTxRunner(db.Conn)
	remove := func(id string, rollback bool) error {
		return runner.InTx(ctx, func(r *MessageTxRepos) error {
			if err := r.ReadState.PrepareMessageDeletion(ctx, id); err != nil {
				return err
			}
			if err := r.Mention.DeleteByMessageID(ctx, id); err != nil {
				return err
			}
			if err := r.Message.Delete(ctx, id); err != nil {
				return err
			}
			if rollback {
				return errors.New("injected late failure")
			}
			return nil
		})
	}
	if err := remove(ids[30], false); err != nil {
		t.Fatal(err)
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].MentionCount != 29 || rows[0].UnreadCount != 29 {
		t.Fatalf("deleted read anchor lost boundary: %+v, %v", rows, err)
	}
	if err := remove(ids[59], true); err == nil {
		t.Fatal("expected rollback")
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].MentionCount != 29 || rows[0].UnreadCount != 29 {
		t.Fatalf("rollback lost read state: %+v, %v", rows, err)
	}
	if err := remove(ids[59], false); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT unread_count FROM channel_reads WHERE user_id=? AND channel_id=?`, msgSecondUser, msgChannel).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 28 {
		t.Fatalf("deleted unread count=%d want 28", count)
	}
}

func TestReadStateOldestUnreadMessageUsesCursorAndStableTieOrder(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	ctx := context.Background()
	read := NewSQLiteReadStateRepo(wrapForRepo(db))

	// Equal timestamps exercise the ID tie-breaker. The caller's own rows are
	// never unread, and the oldest-unread value contains no message content.
	for _, row := range []struct{ id, user string }{
		{"a-own", msgSecondUser},
		{"b-first", msgAuthor},
		{"c-own", msgSecondUser},
		{"d-next", msgAuthor},
	} {
		if _, err := db.Conn.Exec(`INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)`, row.id, msgChannel, row.user, "secret body", "2026-01-01 10:00:00"); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].UnreadCount != 2 || rows[0].OldestUnreadMessageID == nil || *rows[0].OldestUnreadMessageID != "b-first" {
		t.Fatalf("cursorless unread: rows=%+v err=%v", rows, err)
	}

	// Read through b-first, then represent one remaining unread row. The next
	// message is found strictly after the persisted cursor, even at equal time.
	if err := read.Upsert(ctx, msgSecondUser, msgChannel, "b-first"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE channel_reads SET unread_count=1 WHERE user_id=? AND channel_id=?`, msgSecondUser, msgChannel); err != nil {
		t.Fatal(err)
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].OldestUnreadMessageID == nil || *rows[0].OldestUnreadMessageID != "d-next" {
		t.Fatalf("cursor-bound unread: rows=%+v err=%v", rows, err)
	}

	// Deletion repairs a cursor to the previous message; the remaining target
	// stays the same instead of disappearing or moving into message plaintext.
	if err := read.PrepareMessageDeletion(ctx, "b-first"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`DELETE FROM messages WHERE id=?`, "b-first"); err != nil {
		t.Fatal(err)
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 1 || rows[0].OldestUnreadMessageID == nil || *rows[0].OldestUnreadMessageID != "d-next" {
		t.Fatalf("deleted-cursor unread: rows=%+v err=%v", rows, err)
	}

	if err := read.Upsert(ctx, msgSecondUser, msgChannel, "d-next"); err != nil {
		t.Fatal(err)
	}
	rows, err = read.GetUnreadCounts(ctx, msgSecondUser, "srv-1")
	if err != nil || len(rows) != 0 {
		t.Fatalf("all-read channel returned unread anchor: rows=%+v err=%v", rows, err)
	}
}
