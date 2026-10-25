package repository

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const (
	entranceVoiceA = "entrance-voice-a"
	entranceTextA  = "entrance-text-a"
	entranceVoiceB = "entrance-voice-b"
)

// seedEntranceWorld = seedEmojiWorld (alice/bob/carol, servers A/B/C) plus
// a voice and a text channel on A and a voice channel on B.
func seedEntranceWorld(t *testing.T, db *database.DB) {
	t.Helper()
	seedEmojiWorld(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, 'ses', 'voice', ?)`, []any{entranceVoiceA, emojiSrvA}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, 'genel', 'text', ?)`, []any{entranceTextA, emojiSrvA}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, 'ses', 'voice', ?)`, []any{entranceVoiceB, emojiSrvB}},
	})
}

func newEntranceSound(id, userID string) *models.EntranceSound {
	return &models.EntranceSound{
		ID: id, UserID: userID, Name: "clip " + id[:4],
		URL: "/api/uploads/entrance/" + id + ".wav", DurationMs: 1200, Size: 57644,
	}
}

func mustCreateEntranceSound(t *testing.T, repo EntranceRepository, s *models.EntranceSound) {
	t.Helper()
	if err := repo.CreateSoundWithCap(context.Background(), s, models.MaxEntranceSoundsPerUser); err != nil {
		t.Fatalf("CreateSoundWithCap(%s): %v", s.ID, err)
	}
}

// entranceFKOffConn opens a second connection with foreign_keys OFF — the
// Turso condition — closed with the test.
func entranceFKOffConn(t *testing.T, path string) *sql.DB {
	t.Helper()
	if database.IsPostgresDSN(path) {
		return postgresFixtureFKOffConn(t, path)
	}
	conn, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fk-off conn: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestEntranceRepo_SoundCRUDAndOwnership(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newEntranceSound("0123456789abcdef", dmAlice)
	mustCreateEntranceSound(t, repo, s)
	assertRFC3339UTC(t, "created_at after create", s.CreatedAt)

	got, err := repo.GetSound(ctx, dmAlice, s.ID)
	if err != nil {
		t.Fatalf("GetSound: %v", err)
	}
	if got.Name != s.Name || got.URL != s.URL || got.DurationMs != 1200 || got.Size != 57644 {
		t.Errorf("GetSound = %+v, want %+v", got, s)
	}
	assertRFC3339UTC(t, "created_at", got.CreatedAt)

	// Another user's id is NotFound on every per-user method.
	if _, err := repo.GetSound(ctx, dmBob, s.ID); !errors.Is(err, models.ErrEntranceSoundNotFound) {
		t.Errorf("GetSound as bob: err = %v, want ErrEntranceSoundNotFound", err)
	}
	if err := repo.RenameSound(ctx, dmBob, s.ID, "hijack"); !errors.Is(err, models.ErrEntranceSoundNotFound) {
		t.Errorf("RenameSound as bob: err = %v, want ErrEntranceSoundNotFound", err)
	}
	if _, err := repo.DeleteSound(ctx, dmBob, s.ID); !errors.Is(err, models.ErrEntranceSoundNotFound) {
		t.Errorf("DeleteSound as bob: err = %v, want ErrEntranceSoundNotFound", err)
	}

	if err := repo.RenameSound(ctx, dmAlice, s.ID, "Davul"); err != nil {
		t.Fatalf("RenameSound: %v", err)
	}
	list, err := repo.ListSounds(ctx, dmAlice)
	if err != nil || len(list) != 1 || list[0].Name != "Davul" {
		t.Fatalf("ListSounds = %+v, %v; want one renamed clip", list, err)
	}
	empty, err := repo.ListSounds(ctx, dmBob)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("ListSounds(bob) = %#v, %v; want empty non-nil", empty, err)
	}

	urls, err := repo.FileURLsByUser(ctx, dmAlice)
	if err != nil || !slices.Equal(urls, []string{s.URL}) {
		t.Errorf("FileURLsByUser = %v, %v", urls, err)
	}
}

func TestEntranceRepo_CapIsFive(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))

	ids := []string{"a000000000000001", "a000000000000002", "a000000000000003", "a000000000000004", "a000000000000005"}
	for _, id := range ids {
		mustCreateEntranceSound(t, repo, newEntranceSound(id, dmAlice))
	}
	err := repo.CreateSoundWithCap(context.Background(), newEntranceSound("a000000000000006", dmAlice), models.MaxEntranceSoundsPerUser)
	if !errors.Is(err, models.ErrEntranceLimitReached) {
		t.Fatalf("6th clip: err = %v, want ErrEntranceLimitReached", err)
	}
	// The cap is per user: bob can still upload.
	mustCreateEntranceSound(t, repo, newEntranceSound("b000000000000001", dmBob))
}

func TestEntranceRepo_DeleteSoundRemovesSelections(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newEntranceSound("0123456789abcdef", dmAlice)
	mustCreateEntranceSound(t, repo, s)
	for _, scope := range []string{"", emojiSrvA} {
		if err := repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
			UserID: dmAlice, ScopeServerID: scope, Kind: models.EntranceKindClip, SoundID: strPtr(s.ID),
		}); err != nil {
			t.Fatalf("UpsertSelection(%q): %v", scope, err)
		}
	}
	url, err := repo.DeleteSound(ctx, dmAlice, s.ID)
	if err != nil {
		t.Fatalf("DeleteSound: %v", err)
	}
	if url != s.URL {
		t.Errorf("DeleteSound url = %q, want %q", url, s.URL)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_entrance_selection WHERE user_id = ?`, dmAlice); n != 0 {
		t.Errorf("%d selection rows survived DeleteSound, want 0", n)
	}
	if _, err := repo.GetSound(ctx, dmAlice, s.ID); !errors.Is(err, models.ErrEntranceSoundNotFound) {
		t.Errorf("GetSound after delete: err = %v", err)
	}
}

func TestEntranceRepo_ResolveSelectionPriority(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()

	if got, err := repo.ResolveSelection(ctx, dmAlice, emojiSrvA); err != nil || got != nil {
		t.Fatalf("no selection: got %+v, %v; want nil, nil", got, err)
	}

	preset := `{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":800}`
	if err := repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
		UserID: dmAlice, Kind: models.EntranceKindPreset, Preset: strPtr(preset),
	}); err != nil {
		t.Fatalf("UpsertSelection global: %v", err)
	}
	got, err := repo.ResolveSelection(ctx, dmAlice, emojiSrvA)
	if err != nil || got == nil || got.Kind != models.EntranceKindPreset || got.Preset != preset {
		t.Fatalf("global only: got %+v, %v", got, err)
	}

	s := newEntranceSound("0123456789abcdef", dmAlice)
	mustCreateEntranceSound(t, repo, s)
	if err := repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
		UserID: dmAlice, ScopeServerID: emojiSrvA, Kind: models.EntranceKindClip, SoundID: strPtr(s.ID),
	}); err != nil {
		t.Fatalf("UpsertSelection server: %v", err)
	}
	got, err = repo.ResolveSelection(ctx, dmAlice, emojiSrvA)
	if err != nil || got == nil || got.Kind != models.EntranceKindClip || got.SoundURL != s.URL || got.DurationMs != 1200 {
		t.Fatalf("server overrides global: got %+v, %v", got, err)
	}
	// Server B has no override → global applies.
	got, err = repo.ResolveSelection(ctx, dmAlice, emojiSrvB)
	if err != nil || got == nil || got.Kind != models.EntranceKindPreset {
		t.Fatalf("other server falls back to global: got %+v, %v", got, err)
	}

	// Upsert replaces the row in place (PK user_id+scope).
	if err := repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
		UserID: dmAlice, ScopeServerID: emojiSrvA, Kind: models.EntranceKindPreset, Preset: strPtr(preset),
	}); err != nil {
		t.Fatalf("UpsertSelection replace: %v", err)
	}
	rows, err := repo.ListSelections(ctx, dmAlice)
	if err != nil || len(rows) != 2 {
		t.Fatalf("ListSelections = %+v, %v; want 2 rows", rows, err)
	}
	if rows[0].ScopeServerID != "" || rows[1].ScopeServerID != emojiSrvA || rows[1].SoundID != nil {
		t.Errorf("ListSelections rows = %+v", rows)
	}
	assertRFC3339UTC(t, "selection updated_at", rows[0].UpdatedAt)

	if err := repo.DeleteSelection(ctx, dmAlice, ""); err != nil {
		t.Fatalf("DeleteSelection: %v", err)
	}
	if got, _ := repo.ResolveSelection(ctx, dmAlice, emojiSrvB); got != nil {
		t.Errorf("after deleting global, server B resolves %+v, want nil", got)
	}
}

func TestEntranceRepo_SelectionCheckConstraint(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))

	err := repo.UpsertSelection(context.Background(), &models.EntranceSelectionRow{
		UserID: dmAlice, Kind: models.EntranceKindPreset, // preset kind without a preset
	})
	if err == nil {
		t.Fatal("preset selection without a preset accepted, want CHECK failure")
	}
}

func TestEntranceRepo_ServerSettingsChannelsAndMutes(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()

	s, err := repo.GetServerSettings(ctx, emojiSrvA)
	if err != nil || !s.Enabled || s.MaxDurationMs != 5000 || s.DisabledChannelIDs == nil {
		t.Fatalf("default settings = %+v, %v", s, err)
	}
	off := false
	if err := repo.PatchServerSettings(ctx, emojiSrvA, &off, nil); err != nil {
		t.Fatalf("PatchServerSettings enabled: %v", err)
	}
	ms := 1500
	if err := repo.PatchServerSettings(ctx, emojiSrvA, nil, &ms); err != nil {
		t.Fatalf("PatchServerSettings max: %v", err)
	}
	s, _ = repo.GetServerSettings(ctx, emojiSrvA)
	if s.Enabled || s.MaxDurationMs != 1500 {
		t.Errorf("patched settings = %+v, want disabled/1500", s)
	}

	if err := repo.SetChannelDisabled(ctx, emojiSrvA, entranceVoiceA, true); err != nil {
		t.Fatalf("SetChannelDisabled: %v", err)
	}
	if err := repo.SetChannelDisabled(ctx, emojiSrvA, entranceVoiceA, true); err != nil {
		t.Fatalf("SetChannelDisabled (idempotent): %v", err)
	}
	if off, _ := repo.IsChannelDisabled(ctx, entranceVoiceA); !off {
		t.Error("IsChannelDisabled = false after disabling")
	}
	ids, _ := repo.ListDisabledChannels(ctx, emojiSrvA)
	if !slices.Equal(ids, []string{entranceVoiceA}) {
		t.Errorf("ListDisabledChannels = %v", ids)
	}
	if err := repo.SetChannelDisabled(ctx, emojiSrvA, entranceVoiceA, false); err != nil {
		t.Fatalf("SetChannelDisabled enable: %v", err)
	}
	if off, _ := repo.IsChannelDisabled(ctx, entranceVoiceA); off {
		t.Error("IsChannelDisabled = true after re-enabling")
	}

	if err := repo.SetMute(ctx, emojiSrvB, dmBob, true); err != nil {
		t.Fatalf("SetMute: %v", err)
	}
	if err := repo.SetMute(ctx, emojiSrvB, dmBob, true); err != nil {
		t.Fatalf("SetMute (idempotent): %v", err)
	}
	if m, _ := repo.IsMuted(ctx, emojiSrvB, dmBob); !m {
		t.Error("IsMuted = false after mute")
	}
	if m, _ := repo.IsMuted(ctx, emojiSrvA, dmBob); m {
		t.Error("mute leaked to another server")
	}
	mutes, _ := repo.ListMutes(ctx, emojiSrvB)
	if !slices.Equal(mutes, []string{dmBob}) {
		t.Errorf("ListMutes = %v", mutes)
	}
	if err := repo.SetMute(ctx, emojiSrvB, dmBob, false); err != nil {
		t.Fatalf("unmute: %v", err)
	}
	mutes, _ = repo.ListMutes(ctx, emojiSrvB)
	if mutes == nil || len(mutes) != 0 {
		t.Errorf("ListMutes after unmute = %#v, want empty non-nil", mutes)
	}
}

// TestChannelDelete_RemovesEntranceSwitch — sqliteChannelRepo.Delete removes
// the channel's channel_entrance_disabled row even with FKs off (Turso).
func TestChannelDelete_RemovesEntranceSwitch(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedEntranceWorld(t, db)
	repo := NewSQLiteEntranceRepo(wrapForRepo(db))
	ctx := context.Background()
	if err := repo.SetChannelDisabled(ctx, emojiSrvA, entranceVoiceA, true); err != nil {
		t.Fatalf("SetChannelDisabled: %v", err)
	}

	fkOff := entranceFKOffConn(t, path)
	if err := NewSQLiteChannelRepo(fkOff).Delete(ctx, entranceVoiceA); err != nil {
		t.Fatalf("channel Delete: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM channel_entrance_disabled WHERE channel_id = ?`, entranceVoiceA); n != 0 {
		t.Errorf("%d channel_entrance_disabled rows survived the channel delete, want 0", n)
	}
}
