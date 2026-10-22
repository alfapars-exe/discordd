package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestDeleteServerCascade_RemovesEntranceRows runs the cascade over a
// connection with foreign_keys OFF (the Turso condition): the four
// server-scoped entrance tables are emptied for that server only, while the
// user's clip and global selection — user-scoped — survive.
func TestDeleteServerCascade_RemovesEntranceRows(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newEntranceSound("0123456789abcdef", dmAlice)
	mustCreateEntranceSound(t, repo, s)
	preset := `{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":800}`
	for _, sel := range []models.EntranceSelectionRow{
		{UserID: dmAlice, ScopeServerID: "", Kind: models.EntranceKindClip, SoundID: &s.ID},
		{UserID: dmAlice, ScopeServerID: emojiSrvA, Kind: models.EntranceKindPreset, Preset: &preset},
		{UserID: dmAlice, ScopeServerID: emojiSrvB, Kind: models.EntranceKindPreset, Preset: &preset},
	} {
		if err := repo.UpsertSelection(ctx, &sel); err != nil {
			t.Fatalf("UpsertSelection: %v", err)
		}
	}
	off := false
	for _, srv := range []string{emojiSrvA, emojiSrvB} {
		if err := repo.PatchServerSettings(ctx, srv, &off, nil); err != nil {
			t.Fatalf("PatchServerSettings: %v", err)
		}
		if err := repo.SetMute(ctx, srv, dmBob, true); err != nil {
			t.Fatalf("SetMute: %v", err)
		}
	}
	if err := repo.SetChannelDisabled(ctx, emojiSrvA, entranceVoiceA, true); err != nil {
		t.Fatalf("SetChannelDisabled A: %v", err)
	}
	if err := repo.SetChannelDisabled(ctx, emojiSrvB, entranceVoiceB, true); err != nil {
		t.Fatalf("SetChannelDisabled B: %v", err)
	}

	if err := deleteServerCascade(ctx, entranceFKOffConn(t, path), emojiSrvA); err != nil {
		t.Fatalf("deleteServerCascade: %v", err)
	}

	for _, q := range []string{
		`SELECT COUNT(*) FROM user_entrance_selection WHERE scope_server_id = ?`,
		`SELECT COUNT(*) FROM channel_entrance_disabled WHERE server_id = ?`,
		`SELECT COUNT(*) FROM server_entrance_mutes WHERE server_id = ?`,
		`SELECT COUNT(*) FROM server_entrance_settings WHERE server_id = ?`,
	} {
		if n := countRows(t, db, q, emojiSrvA); n != 0 {
			t.Errorf("%q = %d after cascade, want 0", q, n)
		}
		if n := countRows(t, db, q, emojiSrvB); n != 1 {
			t.Errorf("%q for the sibling server = %d, want 1", q, n)
		}
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_entrance_sounds WHERE user_id = ?`, dmAlice); n != 1 {
		t.Errorf("user's clip rows = %d after server delete, want 1 (user-scoped)", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_entrance_selection WHERE user_id = ? AND scope_server_id = ''`, dmAlice); n != 1 {
		t.Errorf("global selection rows = %d after server delete, want 1", n)
	}
}
