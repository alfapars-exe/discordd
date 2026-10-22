package repository

import (
	"context"
	"testing"
)

// TestIsPublicAsset_EntranceSounds — a clip URL is public exactly while its
// user_entrance_sounds row exists (DB-row rule, no "entrance/" prefix rule):
// an unrelated entrance-shaped URL is never public.
func TestIsPublicAsset_EntranceSounds(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	entrance := NewSQLiteEntranceRepo(wrapForRepo(db))
	assets := NewSQLiteMediaAssetRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newEntranceSound("0123456789abcdef", dmAlice)
	mustCreateEntranceSound(t, entrance, s)

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
	check(s.URL, true)
	check("/api/uploads/entrance/fedcba9876543210.wav", false)

	if _, err := entrance.DeleteSound(ctx, dmAlice, s.ID); err != nil {
		t.Fatalf("DeleteSound: %v", err)
	}
	check(s.URL, false)
}
