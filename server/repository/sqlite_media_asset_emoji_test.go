package repository

import (
	"context"
	"testing"
)

// TestIsPublicAsset_ServerEmojis — both emoji file columns are public while
// the row exists, and stop being public the moment it is deleted (no
// "emojis/" prefix rule, so a leftover file on disk is not served).
func TestIsPublicAsset_ServerEmojis(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	assets := NewSQLiteMediaAssetRepo(wrapForRepo(db))
	ctx := context.Background()

	e := newEmoji("aaaaaaaaaaaaaaaa", emojiSrvA, "kedi", true, dmAlice)
	mustCreateEmoji(t, emojis, e)

	check := func(url string, want bool) {
		t.Helper()
		got, err := assets.IsPublicAsset(ctx, url)
		if err != nil {
			t.Fatalf("IsPublicAsset(%q): %v", url, err)
		}
		if got != want {
			t.Errorf("IsPublicAsset(%q) = %v, want %v", url, got, want)
		}
	}
	check(e.URL, true)
	check(*e.AnimatedURL, true)
	check("/api/uploads/emojis/bbbbbbbbbbbbbbbb.png", false)

	if err := emojis.Delete(ctx, emojiSrvA, e.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	check(e.URL, false)
	check(*e.AnimatedURL, false)
}
