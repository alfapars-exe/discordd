// Tests for sqliteDMSettingsRepo mute expiry filtering and the A-28 format
// guard. The write-side bug lived in models.MuteDMRequest.ParseMutedUntil
// (RFC3339 instead of "YYYY-MM-DD HH:MM:SS" — see models/dm_settings.go);
// the repository itself only stores whatever *string it is handed, so these
// tests exercise the real production path through ParseMutedUntil rather
// than a repo-local format helper. DB harness: testdb_test.go.
package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// newDMSettingsChannel seeds the two DM users and an accepted channel
// between them, returning the channel id.
func newDMSettingsChannel(t *testing.T, db *database.DB) string {
	t.Helper()
	seedDMUsers(t, db)
	dmRepo := NewSQLiteDMRepo(db.Conn)
	ch := newDMChannel(t, context.Background(), dmRepo, dmAlice, dmBob, models.DMStatusAccepted)
	return ch.ID
}

// rawDMMutedUntil reads the column's ACTUAL stored bytes via CAST(... AS
// TEXT) — see rawExpiresAt in sqlite_member_timeout_test.go for why a plain
// scan target would mask the on-disk format.
func rawDMMutedUntil(t testing.TB, db *database.DB, userID, channelID string) *string {
	t.Helper()
	var raw *string
	if err := db.Conn.QueryRow(
		`SELECT CAST(muted_until AS TEXT) FROM user_dm_settings WHERE user_id = ? AND dm_channel_id = ?`,
		userID, channelID,
	).Scan(&raw); err != nil {
		t.Fatalf("read raw muted_until: %v", err)
	}
	return raw
}

// TestDMSettingsRepo_MuteDM_ParseMutedUntil_FormatGuard pins the A-28 fix:
// MuteDMRequest.ParseMutedUntil must produce a "YYYY-MM-DD HH:MM:SS" string
// (no 'T'), and a mute created through it must read as active via the real
// `muted_until > datetime('now')` filter.
func TestDMSettingsRepo_MuteDM_ParseMutedUntil_FormatGuard(t *testing.T) {
	db := newTestDB(t)
	channelID := newDMSettingsChannel(t, db)
	repo := NewSQLiteDMSettingsRepo(wrapForRepo(db))
	ctx := context.Background()

	mutedUntil := (&models.MuteDMRequest{Duration: "1h"}).ParseMutedUntil()
	if err := repo.SetMutedUntil(ctx, dmAlice, channelID, mutedUntil); err != nil {
		t.Fatalf("SetMutedUntil: %v", err)
	}

	raw := rawDMMutedUntil(t, db, dmAlice, channelID)
	if raw == nil || !expiryFormatRe.MatchString(*raw) {
		t.Errorf("stored muted_until = %v, want YYYY-MM-DD HH:MM:SS format (no 'T')", raw)
	}

	muted, err := repo.GetMutedChannelIDs(ctx, dmAlice)
	if err != nil {
		t.Fatalf("GetMutedChannelIDs: %v", err)
	}
	if len(muted) != 1 || muted[0] != channelID {
		t.Errorf("GetMutedChannelIDs = %v, want exactly [%s]", muted, channelID)
	}
}

// TestDMSettingsRepo_MuteDM_Forever pins the sentinel behavior: "forever"
// stores MuteForeverSentinel verbatim ("YYYY-MM-DD HH:MM:SS", same shape as
// every other muted_until write — its "9999" year prefix alone guarantees
// > now() regardless of separator, but the column stays single-format) and
// the channel reads as muted.
func TestDMSettingsRepo_MuteDM_Forever(t *testing.T) {
	db := newTestDB(t)
	channelID := newDMSettingsChannel(t, db)
	repo := NewSQLiteDMSettingsRepo(wrapForRepo(db))
	ctx := context.Background()

	mutedUntil := (&models.MuteDMRequest{Duration: "forever"}).ParseMutedUntil()
	if mutedUntil == nil || *mutedUntil != models.MuteForeverSentinel {
		t.Fatalf("ParseMutedUntil(forever) = %v, want %q", mutedUntil, models.MuteForeverSentinel)
	}
	if err := repo.SetMutedUntil(ctx, dmAlice, channelID, mutedUntil); err != nil {
		t.Fatalf("SetMutedUntil: %v", err)
	}

	// Format guard: the sentinel itself must match expiryFormatRe now that
	// it's no longer RFC3339-shaped.
	raw := rawDMMutedUntil(t, db, dmAlice, channelID)
	if raw == nil || !expiryFormatRe.MatchString(*raw) {
		t.Errorf("stored sentinel muted_until = %v, want YYYY-MM-DD HH:MM:SS format (no 'T')", raw)
	}

	muted, err := repo.GetMutedChannelIDs(ctx, dmAlice)
	if err != nil {
		t.Fatalf("GetMutedChannelIDs: %v", err)
	}
	if len(muted) != 1 || muted[0] != channelID {
		t.Errorf("GetMutedChannelIDs = %v, want exactly [%s]", muted, channelID)
	}
}

// TestDMSettingsRepo_MuteDM_PastExpiry_NotActive controls the past case
// directly (ParseMutedUntil only ever produces future durations).
func TestDMSettingsRepo_MuteDM_PastExpiry_NotActive(t *testing.T) {
	db := newTestDB(t)
	channelID := newDMSettingsChannel(t, db)
	repo := NewSQLiteDMSettingsRepo(wrapForRepo(db))
	ctx := context.Background()

	past := time.Now().UTC().Add(-time.Hour).Format("2006-01-02 15:04:05")
	if err := repo.SetMutedUntil(ctx, dmAlice, channelID, &past); err != nil {
		t.Fatalf("SetMutedUntil: %v", err)
	}

	muted, err := repo.GetMutedChannelIDs(ctx, dmAlice)
	if err != nil {
		t.Fatalf("GetMutedChannelIDs: %v", err)
	}
	if len(muted) != 0 {
		t.Errorf("GetMutedChannelIDs = %v, want empty for an already-expired mute", muted)
	}
}

// TestDMSettingsRepo_Migration077_NormalizesLegacyRFC3339Row plants a
// pre-A-28-fix RFC3339 muted_until directly via raw SQL — the shape the old
// ParseMutedUntil used to write — and proves 077 normalizes it, is
// idempotent, and that an already-past legacy mute correctly reads as
// inactive afterwards (before the fix it would still show muted, since
// 'T' > ' ' sorts the RFC3339 string after datetime('now') regardless of
// how far in the past it really is).
func TestDMSettingsRepo_Migration077_NormalizesLegacyRFC3339Row(t *testing.T) {
	db := newTestDB(t)
	channelID := newDMSettingsChannel(t, db)
	repo := NewSQLiteDMSettingsRepo(wrapForRepo(db))
	ctx := context.Background()

	// Midnight of the CURRENT UTC date, not "an hour ago". The legacy-format
	// bug this test demonstrates is a string comparison against
	// datetime('now'), and it only bites when the date parts match: then
	// 'T' (0x54) > ' ' (0x20) decides and the past timestamp wrongly reads
	// as still muted. An hour before midnight UTC the dates differ,
	// '...-08-01T23:..' < '...-08-02 00:..' compares on the date instead,
	// and the row correctly reads as unmuted -- so the assertion below
	// failed for one hour every day for a reason unrelated to the code
	// under test. Midnight-of-today is always same-date and always <= now.
	legacyMutedUntil := time.Now().UTC().Format("2006-01-02") + "T00:00:00Z"
	if _, err := db.Conn.Exec(
		`INSERT INTO user_dm_settings (user_id, dm_channel_id, muted_until) VALUES (?, ?, ?)`,
		dmAlice, channelID, legacyMutedUntil,
	); err != nil {
		t.Fatalf("plant legacy RFC3339 row: %v", err)
	}

	raw := rawDMMutedUntil(t, db, dmAlice, channelID)
	if raw == nil || !strings.Contains(*raw, "T") {
		t.Fatalf("setup: expected planted row to contain 'T' (RFC3339), got %v", raw)
	}

	// Before normalization: the (buggy) legacy row still reads as muted.
	muted, err := repo.GetMutedChannelIDs(ctx, dmAlice)
	if err != nil {
		t.Fatalf("GetMutedChannelIDs before 077: %v", err)
	}
	if len(muted) != 1 {
		t.Fatalf("setup: expected the legacy RFC3339 row to still read as muted before 077, got %v", muted)
	}

	exec077Migration(t, db)

	raw = rawDMMutedUntil(t, db, dmAlice, channelID)
	if raw == nil || !expiryFormatRe.MatchString(*raw) {
		t.Errorf("after 077: muted_until = %v, want YYYY-MM-DD HH:MM:SS format", raw)
	}

	muted, err = repo.GetMutedChannelIDs(ctx, dmAlice)
	if err != nil {
		t.Fatalf("GetMutedChannelIDs after 077: %v", err)
	}
	if len(muted) != 0 {
		t.Errorf("GetMutedChannelIDs after 077 = %v, want empty (expired mute normalized)", muted)
	}

	// Idempotent: running it again must not error or change the value.
	exec077Migration(t, db)
	raw2 := rawDMMutedUntil(t, db, dmAlice, channelID)
	if raw2 == nil || *raw2 != *raw {
		t.Errorf("077 is not idempotent: first=%v second=%v", raw, raw2)
	}
}
