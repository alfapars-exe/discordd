package repository

import (
	"context"
	"slices"
	"testing"
)

// TestDeleteServerCascade_RemovesServerEmojis runs the cascade over a
// connection with foreign_keys OFF — the Turso condition — so the emoji rows
// can only disappear through the explicit server_emojis statement, not the
// declared ON DELETE CASCADE. The sibling server's emoji must survive.
func TestDeleteServerCascade_RemovesServerEmojis(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedEmojiWorld(t, db)
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	mustCreateEmoji(t, emojis, newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "kedi", true, dmAlice))
	mustCreateEmoji(t, emojis, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvB, "kedi", false, dmAlice))

	fkOff := entranceFKOffConn(t, path)

	if err := deleteServerCascade(context.Background(), fkOff, emojiSrvA); err != nil {
		t.Fatalf("deleteServerCascade: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_emojis WHERE server_id = ?`, emojiSrvA); n != 0 {
		t.Errorf("%d server_emojis rows survived the cascade, want 0", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_emojis WHERE server_id = ?`, emojiSrvB); n != 1 {
		t.Errorf("sibling server's emoji rows = %d, want 1", n)
	}
}

// TestGetFileURLsByServerID_IncludesEmojiFiles — the delete path collects
// every emoji file (static + animated) of the server, and only that server.
func TestGetFileURLsByServerID_IncludesEmojiFiles(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	animated := newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "dans", true, dmAlice)
	static := newEmoji("aaaaaaaaaaaaaaa2", emojiSrvA, "kedi", false, dmAlice)
	other := newEmoji("aaaaaaaaaaaaaaa3", emojiSrvB, "kedi", false, dmAlice)
	mustCreateEmoji(t, emojis, animated)
	mustCreateEmoji(t, emojis, static)
	mustCreateEmoji(t, emojis, other)

	urls, err := NewSQLiteServerRepo(wrapForRepo(db)).GetFileURLsByServerID(context.Background(), emojiSrvA)
	if err != nil {
		t.Fatalf("GetFileURLsByServerID: %v", err)
	}
	want := []string{animated.URL, *animated.AnimatedURL, static.URL}
	slices.Sort(urls)
	slices.Sort(want)
	if !slices.Equal(urls, want) {
		t.Errorf("urls = %v, want %v", urls, want)
	}
}
