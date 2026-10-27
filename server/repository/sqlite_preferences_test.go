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

func TestSQLitePreferencesGetManyStrictIsBoundedAndDefaultsMissingRows(t *testing.T) {
	_, repo := preferencesTestRepo(t)
	ctx := context.Background()
	if _, err := repo.Upsert(ctx, "prefs-user", json.RawMessage(`{"privacy":{"profileAudience":"friends_only"}}`)); err != nil {
		t.Fatal(err)
	}
	bulk, ok := repo.(interface {
		GetManyStrict(context.Context, []string) (map[string]*models.UserPreferences, error)
	})
	if !ok {
		t.Fatal("preferences repo does not implement strict bounded bulk reads")
	}
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = fmt.Sprintf("missing-%d", i)
	}
	ids[1000] = "prefs-user"
	ids = append(ids, "prefs-user") // duplicates must not alter the result.
	got, err := bulk.GetManyStrict(ctx, ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1001 {
		t.Fatalf("GetManyStrict returned %d IDs, want 1001 unique IDs", len(got))
	}
	if string(got["missing-0"].Data) != `{}` {
		t.Fatalf("missing-row default = %s, want {}", got["missing-0"].Data)
	}
	if !strings.Contains(string(got["prefs-user"].Data), `"friends_only"`) {
		t.Fatalf("stored preference missing from batch result: %s", got["prefs-user"].Data)
	}
}

func TestProfileAudienceBatchReaderRejectsCorruptPreferences(t *testing.T) {
	db, repo := preferencesTestRepo(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, args: []any{"valid-prefs-user", "validprefsuser", "x"}}})
	ctx := context.Background()
	const optIn = `{"notifications":{"channelMessageNotifications":true},"privacy":{"profileAudience":"friends_only"}}`
	if _, err := repo.Upsert(ctx, "valid-prefs-user", json.RawMessage(optIn)); err != nil {
		t.Fatal(err)
	}
	privacyReader := repo.(interface {
		GetManyStrict(context.Context, []string) (map[string]*models.UserPreferences, error)
	})
	for name, corrupt := range map[string]string{
		"malformed": `{`, "array": `[]`, "null": `null`, "string": `"text"`, "number": `42`, "boolean": `true`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := db.Conn.Exec(`INSERT INTO user_preferences (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, "prefs-user", corrupt); err != nil {
				t.Fatal(err)
			}
			ids := []string{"prefs-user", "valid-prefs-user"}
			// A corrupt recipient must not poison the healthy opt-in on the same page.
			got, err := repo.(PreferencesBatchReader).GetMany(ctx, ids)
			if err != nil {
				t.Fatalf("tolerant notification preference read: %v", err)
			}
			if got["prefs-user"] == nil || string(got["prefs-user"].Data) != `{}` {
				t.Fatalf("corrupt notification preferences = %#v, want opt-out {}", got["prefs-user"])
			}
			if got["valid-prefs-user"] == nil || !strings.Contains(string(got["valid-prefs-user"].Data), `"channelMessageNotifications":true`) {
				t.Fatal("healthy opt-in recipient was lost from tolerant preference page")
			}
			if _, err := privacyReader.GetManyStrict(ctx, ids); err == nil {
				t.Fatal("strict profile reader accepted corrupt preference and could expose default all_servers profile")
			}
		})
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
