// MessageTxRunner atomicity tests against a real local SQLite database —
// the proof that a failure inside the message-create write set leaves no
// orphan rows behind (the service-level tests use a mock runner and only
// verify error propagation).
package repository

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// newTxTestDB boots a throwaway file-backed DB with the full embedded
// migration set so repo SQL runs against the real schema. File path (not
// :memory:) because the pool can hold several connections.
func newTxTestDB(t *testing.T) *database.DB {
	t.Helper()
	// runMigrations expects the FS rooted at the migrations dir (main.go does
	// the same fs.Sub before calling database.New).
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "tx_test.db"), migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func txTestSeed(t *testing.T, db *database.DB) (channelID string, authorID string, readerID string) {
	t.Helper()
	seed := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"author-1", "author"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"reader-1", "reader"}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, ?, 'text', 'default')`, []any{"chan-1", "genel"}},
		{`INSERT INTO channel_reads (user_id, channel_id, unread_count) VALUES (?, ?, 0)`, []any{"reader-1", "chan-1"}},
	}
	for _, s := range seed {
		if _, err := db.Conn.Exec(s.q, s.args...); err != nil {
			t.Fatalf("seed %q: %v", s.q, err)
		}
	}
	return "chan-1", "author-1", "reader-1"
}

func countRows(t *testing.T, db *database.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := db.Conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func TestMessageTxRunner_CommitsWholeWriteSet(t *testing.T) {
	db := newTxTestDB(t)
	channelID, authorID, readerID := txTestSeed(t, db)
	runner := NewMessageTxRunner(db.Conn)
	ctx := context.Background()

	content := "merhaba @reader"
	msg := &models.Message{ChannelID: channelID, UserID: authorID, Content: &content}
	err := runner.InTx(ctx, func(r *MessageTxRepos) error {
		if err := r.Message.Create(ctx, msg); err != nil {
			return err
		}
		if err := r.ReadState.IncrementUnreadCounts(ctx, channelID, authorID); err != nil {
			return err
		}
		return r.Mention.SaveMentions(ctx, msg.ID, []string{readerID})
	})
	if err != nil {
		t.Fatalf("InTx: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM messages`); n != 1 {
		t.Errorf("messages = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, msg.ID); n != 1 {
		t.Errorf("mentions = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT unread_count FROM channel_reads WHERE user_id = ?`, readerID); n != 1 {
		t.Errorf("reader unread_count = %d, want 1", n)
	}
}

// TestMessageTxRunner_RollsBackOnError — the atomicity proof: when a later
// step in the write set fails, the already-inserted message and unread bump
// must vanish with the rollback.
func TestMessageTxRunner_RollsBackOnError(t *testing.T) {
	db := newTxTestDB(t)
	channelID, authorID, readerID := txTestSeed(t, db)
	runner := NewMessageTxRunner(db.Conn)
	ctx := context.Background()

	content := "bu mesaj kalmamalı"
	msg := &models.Message{ChannelID: channelID, UserID: authorID, Content: &content}
	sentinel := errors.New("mention write exploded")
	err := runner.InTx(ctx, func(r *MessageTxRepos) error {
		if err := r.Message.Create(ctx, msg); err != nil {
			return err
		}
		if err := r.ReadState.IncrementUnreadCounts(ctx, channelID, authorID); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("InTx error = %v, want sentinel", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM messages`); n != 0 {
		t.Errorf("messages = %d after rollback, want 0 (orphan message!)", n)
	}
	if n := countRows(t, db, `SELECT unread_count FROM channel_reads WHERE user_id = ?`, readerID); n != 0 {
		t.Errorf("reader unread_count = %d after rollback, want 0 (drifting badge!)", n)
	}
}
