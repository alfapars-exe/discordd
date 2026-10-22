package repository

import (
	"context"
	"database/sql"
	"slices"
	"testing"
)

// TestDeleteServerCascade_RemovesServerStickers runs the cascade over a
// connection with foreign_keys OFF — the Turso condition — so the sticker
// rows can only disappear through the explicit server_stickers statement.
// The sibling server's sticker must survive.
func TestDeleteServerCascade_RemovesServerStickers(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedEmojiWorld(t, db)
	stickers := NewSQLiteStickerRepo(wrapForRepo(db))
	mustCreateSticker(t, stickers, newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "kedi", true, dmAlice))
	mustCreateSticker(t, stickers, newSticker("aaaaaaaaaaaaaaa2", emojiSrvB, "kedi", false, dmAlice))

	fkOff, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fk-off conn: %v", err)
	}
	defer func() { _ = fkOff.Close() }()

	if err := deleteServerCascade(context.Background(), fkOff, emojiSrvA); err != nil {
		t.Fatalf("deleteServerCascade: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_stickers WHERE server_id = ?`, emojiSrvA); n != 0 {
		t.Errorf("%d server_stickers rows survived the cascade, want 0", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_stickers WHERE server_id = ?`, emojiSrvB); n != 1 {
		t.Errorf("sibling server's sticker rows = %d, want 1", n)
	}
}

// TestGetFileURLsByServerID_IncludesStickerFiles — the delete path collects
// every sticker file (static + animated) next to the emoji files, and only
// that server's.
func TestGetFileURLsByServerID_IncludesStickerFiles(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	stickers := NewSQLiteStickerRepo(wrapForRepo(db))
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	animated := newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "dans", true, dmAlice)
	static := newSticker("aaaaaaaaaaaaaaa2", emojiSrvA, "kedi", false, dmAlice)
	other := newSticker("aaaaaaaaaaaaaaa3", emojiSrvB, "kedi", false, dmAlice)
	emoji := newEmoji("bbbbbbbbbbbbbbb1", emojiSrvA, "kedi", false, dmAlice)
	mustCreateSticker(t, stickers, animated)
	mustCreateSticker(t, stickers, static)
	mustCreateSticker(t, stickers, other)
	mustCreateEmoji(t, emojis, emoji)

	urls, err := NewSQLiteServerRepo(wrapForRepo(db)).GetFileURLsByServerID(context.Background(), emojiSrvA)
	if err != nil {
		t.Fatalf("GetFileURLsByServerID: %v", err)
	}
	want := []string{animated.URL, *animated.AnimatedURL, static.URL, emoji.URL}
	slices.Sort(urls)
	slices.Sort(want)
	if !slices.Equal(urls, want) {
		t.Errorf("urls = %v, want %v", urls, want)
	}
}
