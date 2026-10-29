package handlers

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
)

func TestEmailUnsubscribeHandlerSQLiteIntegration(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "email-unsubscribe.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES(?,?,?,?,?)`, "unsubscribe-http-user", "unsubscribe-http", "x", "verified@example.test", 1); err != nil {
		t.Fatal(err)
	}
	initial := `{"email_preferences":{"social":true,"communication":true},"notifications":{"upcomingEventNotifications":true}}`
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, "unsubscribe-http-user", initial); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteEmailUnsubscribeRepo(database.NewRetryingQuerier(db.Conn))
	now := time.Now().UTC()
	token, err := repo.IssueForAddress(ctx, "unsubscribe-http-user", "social", "verified@example.test", now)
	if err != nil {
		t.Fatal(err)
	}
	handler := NewEmailUnsubscribeHandler(repo, nil)
	get := httptest.NewRecorder()
	handler.Confirm(get, httptest.NewRequest(http.MethodGet, "/api/email/unsubscribe?token="+url.QueryEscape(token), nil))
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), "Confirm unsubscribe") {
		t.Fatalf("GET status=%d body=%s", get.Code, get.Body.String())
	}
	var afterGet string
	if err := db.Conn.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, "unsubscribe-http-user").Scan(&afterGet); err != nil {
		t.Fatal(err)
	}
	if afterGet != initial {
		t.Fatalf("GET changed preferences: got %s want %s", afterGet, initial)
	}

	post := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/email/unsubscribe", strings.NewReader(url.Values{"token": {token}}.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		handler.Unsubscribe(w, r)
		return w
	}
	first := post()
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "preference has been updated") {
		t.Fatalf("POST status=%d body=%s", first.Code, first.Body.String())
	}
	assertUnsubscribePreferences(t, db, ctx)
	var firstUsedAt int64
	if err := db.Conn.QueryRowContext(ctx, `SELECT used_at FROM email_unsubscribe_tokens`).Scan(&firstUsedAt); err != nil {
		t.Fatal(err)
	}
	second := post()
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "preference has been updated") {
		t.Fatalf("repeat POST status=%d body=%s", second.Code, second.Body.String())
	}
	assertUnsubscribePreferences(t, db, ctx)
	var secondUsedAt int64
	if err := db.Conn.QueryRowContext(ctx, `SELECT used_at FROM email_unsubscribe_tokens`).Scan(&secondUsedAt); err != nil {
		t.Fatal(err)
	}
	if secondUsedAt != firstUsedAt {
		t.Fatalf("repeat POST changed used_at from %d to %d", firstUsedAt, secondUsedAt)
	}
}

func assertUnsubscribePreferences(t *testing.T, db *database.DB, ctx context.Context) {
	t.Helper()
	var raw string
	if err := db.Conn.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, "unsubscribe-http-user").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatal(err)
	}
	email := data["email_preferences"].(map[string]any)
	if email["social"] != false || email["communication"] != true {
		t.Fatalf("category opt-out not scoped: %#v", email)
	}
	notifications := data["notifications"].(map[string]any)
	if notifications["upcomingEventNotifications"] != true {
		t.Fatalf("unrelated preferences changed: %#v", data)
	}
}
