// sqliteDMReadRepo against a real local SQLite database (migration 081).
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestDMReadRepo_IncrementAndMarkRead(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	dmRepo := NewSQLiteDMRepo(db.Conn)
	repo := NewSQLiteDMReadRepo(wrapForRepo(db))
	ctx := context.Background()
	ch := newDMChannel(t, ctx, dmRepo, dmAlice, dmBob, models.DMStatusAccepted)

	t.Run("increment creates the row at 1 then bumps it", func(t *testing.T) {
		if err := repo.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			t.Fatalf("IncrementUnread: %v", err)
		}
		if n := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id = ? AND dm_channel_id = ?`, dmBob, ch.ID); n != 1 {
			t.Fatalf("unread_count after first increment = %d, want 1", n)
		}
		if err := repo.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			t.Fatalf("IncrementUnread (second): %v", err)
		}
		if n := countRows(t, db, `SELECT unread_count FROM dm_reads WHERE user_id = ? AND dm_channel_id = ?`, dmBob, ch.ID); n != 2 {
			t.Fatalf("unread_count after second increment = %d, want 2", n)
		}
		// Per-user: the sender's own row is never touched.
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_reads WHERE user_id = ?`, dmAlice); n != 0 {
			t.Fatalf("alice has %d dm_reads rows, want 0", n)
		}
	})

	t.Run("mark read with a message id resets the counter and sets the watermark", func(t *testing.T) {
		msg := newDMMessage(t, ctx, dmRepo, ch.ID, dmAlice, "selam")
		if err := repo.MarkRead(ctx, dmBob, ch.ID, &msg.ID); err != nil {
			t.Fatalf("MarkRead: %v", err)
		}
		var unread int
		var lastRead *string
		if err := db.Conn.QueryRow(
			`SELECT unread_count, last_read_message_id FROM dm_reads WHERE user_id = ? AND dm_channel_id = ?`,
			dmBob, ch.ID,
		).Scan(&unread, &lastRead); err != nil {
			t.Fatalf("read row: %v", err)
		}
		if unread != 0 {
			t.Errorf("unread_count = %d, want 0", unread)
		}
		if lastRead == nil || *lastRead != msg.ID {
			t.Errorf("last_read_message_id = %v, want %q", lastRead, msg.ID)
		}
	})

	t.Run("mark read without a message id keeps the stored watermark", func(t *testing.T) {
		if err := repo.IncrementUnread(ctx, dmBob, ch.ID); err != nil {
			t.Fatalf("IncrementUnread: %v", err)
		}
		if err := repo.MarkRead(ctx, dmBob, ch.ID, nil); err != nil {
			t.Fatalf("MarkRead(nil): %v", err)
		}
		var unread int
		var lastRead *string
		if err := db.Conn.QueryRow(
			`SELECT unread_count, last_read_message_id FROM dm_reads WHERE user_id = ? AND dm_channel_id = ?`,
			dmBob, ch.ID,
		).Scan(&unread, &lastRead); err != nil {
			t.Fatalf("read row: %v", err)
		}
		if unread != 0 {
			t.Errorf("unread_count = %d, want 0", unread)
		}
		if lastRead == nil {
			t.Error("last_read_message_id was cleared by a body-less mark-read, want the previous watermark kept")
		}
	})

	t.Run("mark read on a channel with no row inserts one at 0", func(t *testing.T) {
		other := newDMChannel(t, ctx, dmRepo, dmAlice, dmCarol, models.DMStatusAccepted)
		if err := repo.MarkRead(ctx, dmCarol, other.ID, nil); err != nil {
			t.Fatalf("MarkRead: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_reads WHERE user_id = ? AND dm_channel_id = ? AND unread_count = 0 AND last_read_message_id IS NULL`, dmCarol, other.ID); n != 1 {
			t.Fatalf("fresh mark-read row count = %d, want 1", n)
		}
	})

	t.Run("last_read_at is stored as space-separated UTC text", func(t *testing.T) {
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_reads WHERE user_id = ? AND last_read_at NOT LIKE '____-__-__ __:__:__'`, dmBob); n != 0 {
			t.Errorf("%d dm_reads rows have a last_read_at outside 'YYYY-MM-DD HH:MM:SS'", n)
		}
	})
}
