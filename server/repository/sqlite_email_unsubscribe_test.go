package repository

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestEmailUnsubscribeIssueInspectConsumePreservesPreferences(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('unsubscribe-user','unsubscribe','x','user@example.test',1)`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('unsubscribe-user','{"email_preferences":{"social":true,"communication":true},"notifications":{"upcomingEventNotifications":true}}')`},
	})
	repo := NewSQLiteEmailUnsubscribeRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	raw, err := repo.Issue(ctx, "unsubscribe-user", "social", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 43 {
		t.Fatalf("opaque token length=%d, want 43 base64url chars", len(raw))
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(byteMustDecodeURL(t, raw)))
	var storedHash string
	if err := db.Conn.QueryRow(`SELECT token_hash FROM email_unsubscribe_tokens`).Scan(&storedHash); err != nil || storedHash != hash || storedHash == raw {
		t.Fatalf("stored token hash=%q want hash %q: %v", storedHash, hash, err)
	}
	state, err := repo.Inspect(ctx, raw, now)
	if err != nil || state.Category != "social" || state.Consumed {
		t.Fatalf("inspect=%+v, %v", state, err)
	}
	if err := repo.Consume(ctx, raw, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := repo.Consume(ctx, raw, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("repeat consume was not idempotent: %v", err)
	}
	state, err = repo.Inspect(ctx, raw, now.Add(2*time.Minute))
	if err != nil || state.Category != "social" || !state.Consumed {
		t.Fatalf("consumed inspect=%+v, %v", state, err)
	}
	var data string
	if err := db.Conn.QueryRow(`SELECT data FROM user_preferences WHERE user_id='unsubscribe-user'`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var prefs map[string]any
	if err := json.Unmarshal([]byte(data), &prefs); err != nil {
		t.Fatal(err)
	}
	mail := prefs["email_preferences"].(map[string]any)
	if mail["social"] != false || mail["communication"] != true {
		t.Fatalf("email preferences not category-scoped: %#v", mail)
	}
	notifications := prefs["notifications"].(map[string]any)
	if notifications["upcomingEventNotifications"] != true {
		t.Fatalf("unrelated preferences changed: %#v", prefs)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM email_unsubscribe_tokens WHERE used_at IS NOT NULL`) != 1 {
		t.Fatal("token was not marked consumed")
	}
}

func TestEmailUnsubscribeRejectsInvalidExpiredAndStaleGeneration(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES
			('unsubscribe-user','unsubscribe','x','user@example.test',1),
			('unverified-user','unverified','x','pending@example.test',NULL)`},
	})
	repo := NewSQLiteEmailUnsubscribeRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if _, err := repo.Issue(ctx, "unverified-user", "social", now); !errors.Is(err, ErrEmailUnsubscribeIneligible) {
		t.Fatalf("unverified issue err=%v", err)
	}
	if _, err := repo.Issue(ctx, "unsubscribe-user", "security", now); !errors.Is(err, ErrEmailUnsubscribeIneligible) {
		t.Fatalf("unsupported category issue err=%v", err)
	}
	if _, err := repo.Inspect(ctx, "not-a-token", now); !errors.Is(err, ErrEmailUnsubscribeInvalid) {
		t.Fatalf("malformed inspect err=%v", err)
	}
	first, err := repo.Issue(ctx, "unsubscribe-user", "social", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Inspect(ctx, first, now.Add(emailUnsubscribeTokenLifetime)); !errors.Is(err, ErrEmailUnsubscribeInvalid) {
		t.Fatalf("expired inspect err=%v", err)
	}
	if err := repo.Consume(ctx, first, now.Add(emailUnsubscribeTokenLifetime)); !errors.Is(err, ErrEmailUnsubscribeInvalid) {
		t.Fatalf("expired consume err=%v", err)
	}
	second, err := repo.Issue(ctx, "unsubscribe-user", "social", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET email='changed@example.test' WHERE id='unsubscribe-user'`); err != nil {
		t.Fatal(err)
	}
	// A subsequently verified address still cannot revive the old proof.
	if _, err := db.Conn.Exec(`UPDATE users SET email_verified_at=2 WHERE id='unsubscribe-user'`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Inspect(ctx, second, now.Add(time.Minute)); !errors.Is(err, ErrEmailUnsubscribeInvalid) {
		t.Fatalf("stale-generation inspect err=%v", err)
	}
	if err := repo.Consume(ctx, second, now.Add(time.Minute)); !errors.Is(err, ErrEmailUnsubscribeInvalid) {
		t.Fatalf("stale-generation consume err=%v", err)
	}
}

func TestEmailUnsubscribeIssueForAddressRequiresQueuedAddressMatch(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('unsubscribe-user','unsubscribe','x','current@example.test',1)`},
	})
	repo := NewSQLiteEmailUnsubscribeRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if _, err := repo.IssueForAddress(ctx, "unsubscribe-user", "social", "stale@example.test", now); !errors.Is(err, ErrEmailUnsubscribeIneligible) {
		t.Fatalf("stale queued address issue err=%v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_unsubscribe_tokens`); got != 0 {
		t.Fatalf("mismatch issued %d tokens", got)
	}
	if _, err := repo.IssueForAddress(ctx, "unsubscribe-user", "social", "current@example.test", now); err != nil {
		t.Fatalf("current verified address issue err=%v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_unsubscribe_tokens`); got != 1 {
		t.Fatalf("current address issued %d tokens", got)
	}
}

func byteMustDecodeURL(t *testing.T, raw string) []byte {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
