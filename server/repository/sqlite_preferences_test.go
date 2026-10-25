package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func preferencesTestRepo(t *testing.T) (*database.DB, PreferencesRepository) {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, args: []any{"prefs-user", "prefsuser", "x"}}})
	return db, NewSQLitePreferencesRepo(wrapForRepo(db))
}

func TestSQLitePreferencesRecursiveMergeAndCompatibility(t *testing.T) {
	db, repo := preferencesTestRepo(t)
	ctx := context.Background()
	empty, err := repo.Get(ctx, "prefs-user")
	if err != nil || empty.SchemaVersion != 1 || string(empty.Data) != `{}` {
		t.Fatalf("no-row default: %+v %v", empty, err)
	}
	legacy := `{"legacy_namespace":{"keep":true},"voice_settings":{"masterVolume":60,"legacy_field":true,"inputDevice":"old-mic","outputDevice":"old-speaker","cameraDevice":"old-camera","muteHotkeyGlobal":true,"userVolumes":{"alice":80}}}`
	execSeed(t, db, []seedStmt{{q: `INSERT INTO user_preferences (user_id, data) VALUES (?, ?)`, args: []any{"prefs-user", legacy}}})
	got, err := repo.Get(ctx, "prefs-user")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got.Data), "old-") || strings.Contains(string(got.Data), "muteHotkeyGlobal") {
		t.Fatalf("legacy devices exposed: %s", got.Data)
	}
	got, err = repo.Upsert(ctx, "prefs-user", json.RawMessage(`{"voice_settings":{"inputVolume":120,"inputDevice":"new-mic","userVolumes":{"bob":110}},"accessibility":{"chatFontSize":18}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 1 || got.UpdatedAt == "" {
		t.Fatalf("missing metadata: %+v", got)
	}
	var decoded map[string]any
	if err := json.Unmarshal(got.Data, &decoded); err != nil {
		t.Fatal(err)
	}
	voice := decoded["voice_settings"].(map[string]any)
	volumes := voice["userVolumes"].(map[string]any)
	if voice["masterVolume"] != float64(60) || voice["inputVolume"] != float64(120) || voice["legacy_field"] != true || volumes["alice"] != float64(80) || volumes["bob"] != float64(110) || decoded["legacy_namespace"] == nil {
		t.Fatalf("nested or legacy values lost: %s", got.Data)
	}
	var stored string
	if err := db.Conn.QueryRow(`SELECT data FROM user_preferences WHERE user_id = ?`, "prefs-user").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "Device") || strings.Contains(stored, "muteHotkeyGlobal") {
		t.Fatalf("device fields persisted: %s", stored)
	}

	gif := `{"gif_favorites":[{"id":"a","title":"A","url":"https://static.klipy.com/a.gif","preview_url":"https://static.klipy.com/a.jpg","width":10,"height":10}]}`
	if _, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(gif)); err != nil {
		t.Fatal(err)
	}
	got, err = repo.Upsert(ctx, "prefs-user", json.RawMessage(`{"gif_favorites":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got.Data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded["gif_favorites"].([]any)) != 0 || decoded["voice_settings"] == nil {
		t.Fatalf("array replace reset sibling namespace: %s", got.Data)
	}
	other, err := repo.Get(ctx, "other-user")
	if err != nil || string(other.Data) != `{}` {
		t.Fatalf("preferences crossed account boundary: %+v %v", other, err)
	}
}

func TestSQLitePreferencesConcurrentDisjointLeafUpdates(t *testing.T) {
	_, repo := preferencesTestRepo(t)
	ctx := context.Background()
	const writers = 32
	start := make(chan struct{})
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			patch := fmt.Sprintf(`{"voice_settings":{"userVolumes":{"user-%d":%d}},"sidebar_sections":{"section-%d":true}}`, i, i, i)
			_, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(patch))
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
	}
	got, err := repo.Get(ctx, "prefs-user")
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Voice struct {
			UserVolumes map[string]float64 `json:"userVolumes"`
		} `json:"voice_settings"`
		Sections map[string]bool `json:"sidebar_sections"`
	}
	if err := json.Unmarshal(got.Data, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Voice.UserVolumes) != writers || len(decoded.Sections) != writers {
		t.Fatalf("lost concurrent leaf updates: %s", got.Data)
	}
	for i := 0; i < writers; i++ {
		if decoded.Voice.UserVolumes[fmt.Sprintf("user-%d", i)] != float64(i) || !decoded.Sections[fmt.Sprintf("section-%d", i)] {
			t.Errorf("writer %d lost", i)
		}
	}
}

func TestSQLitePreferencesErrorsNeverBecomeSuccess(t *testing.T) {
	db, repo := preferencesTestRepo(t)
	ctx := context.Background()
	if got, err := repo.Upsert(ctx, "nonexistent-user", json.RawMessage(`{"theme":"ocean"}`)); got != nil || err == nil {
		t.Fatal("foreign-key failure returned success")
	}
	for _, bad := range []string{`null`, `[]`, `{"voice_settings":{"masterVolume":null}}`, `{"unrecognized":true}`} {
		if got, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(bad)); got != nil || !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("invalid patch accepted: %s %v", bad, err)
		}
	}
	execSeed(t, db, []seedStmt{{q: `INSERT INTO user_preferences (user_id, data) VALUES (?, ?)`, args: []any{"prefs-user", `{}`}}})
	for _, corrupt := range []string{`null`, `[]`, `{`} {
		if _, err := db.Conn.Exec(`UPDATE user_preferences SET data = ? WHERE user_id = ?`, corrupt, "prefs-user"); err != nil {
			t.Fatal(err)
		}
		if got, err := repo.Get(ctx, "prefs-user"); got != nil || err == nil {
			t.Fatalf("corrupt stored data read as success: %s", corrupt)
		}
		if got, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(`{"theme":"ocean"}`)); got != nil || err == nil {
			t.Fatalf("corrupt stored data silently reset: %s", corrupt)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.Get(ctx, "prefs-user"); got != nil || err == nil {
		t.Fatal("closed database Get returned success")
	}
	if got, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(`{"theme":"ocean"}`)); got != nil || err == nil {
		t.Fatal("closed database Upsert returned success")
	}
}

func TestSQLitePreferencesMergedStorageLimitIsAtomic(t *testing.T) {
	db, repo := preferencesTestRepo(t)
	ctx := context.Background()
	// Simulate a legacy document close to the aggregate quota. A small valid
	// patch must not push it over the quota or alter it before returning failure.
	stored := `{"legacy":"` + strings.Repeat("x", models.MaxPreferencesStoredBytes-40) + `"}`
	execSeed(t, db, []seedStmt{{q: `INSERT INTO user_preferences (user_id, data) VALUES (?, ?)`, args: []any{"prefs-user", stored}}})
	patch := `{"theme":"` + strings.Repeat("y", 128) + `"}`
	if got, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(patch)); got != nil || !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("aggregate quota not enforced: %+v %v", got, err)
	}
	var after string
	if err := db.Conn.QueryRow(`SELECT data FROM user_preferences WHERE user_id = ?`, "prefs-user").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != stored {
		t.Fatal("failed quota check modified stored preferences")
	}
}

func TestSQLitePreferencesCanonicalExpansionCannotExceedInsertLimit(t *testing.T) {
	db, repo := preferencesTestRepo(t)
	// Raw '<' expands to '\u003c' when canonicalized. This patch is under the
	// request quota and map/key limits but its persisted encoding is over 256KiB.
	entries := make([]string, 240)
	for i := range entries {
		entries[i] = fmt.Sprintf(`"%s%d":1`, strings.Repeat("<", 245), i)
	}
	patch := json.RawMessage(`{"voice_settings":{"userVolumes":{` + strings.Join(entries, ",") + `}}}`)
	if err := (&models.UpdatePreferencesRequest{Data: patch}).Validate(); err != nil {
		t.Fatalf("test patch must pass raw validation: %v", err)
	}
	if got, err := repo.Upsert(context.Background(), "prefs-user", patch); got != nil || !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expanded insert exceeded aggregate quota: %+v %v", got, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM user_preferences`) != 0 {
		t.Fatal("oversized canonical insert wrote a row")
	}
}
