package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

// newTestDB runs this same production-repository round trip against SQLite
// and against the isolated PostgreSQL fixture when its test DSN is supplied.
func TestDataExportOwnAccountProfileProjection(t *testing.T) {
	for _, mode := range []string{"populated", "null", "empty"} {
		t.Run(mode, func(t *testing.T) {
			db := newTestDB(t)
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO users(id,username,password_hash,email,is_platform_admin,platform_ban_reason,token_version) VALUES('profile-owner','profileowner','excluded-password-hash','owner@example.test',1,'excluded-moderation-reason',7)`},
				{q: `INSERT INTO users(id,username,password_hash,bio,avatar_url) VALUES('profile-peer','profilepeer','excluded-peer-hash','excluded-peer-bio','excluded-peer-avatar')`},
			})
			fields := []string{"display_name", "avatar_url", "avatar_animated_url", "banner_url", "banner_animated_url", "wallpaper_url", "bio", "pronouns", "accent_color", "custom_status"}
			var value any
			if mode != "null" {
				value = ""
			}
			want := map[string]any{
				"id": "profile-owner", "username": "profileowner", "email": "owner@example.test", "language": "tr",
				"status": "online", "pref_status": "invisible", "dm_privacy": "friends_only",
				"last_seen_at": "2026-10-26T12:34:56Z",
			}
			var values []any
			for _, field := range fields {
				v := value
				if mode == "populated" {
					v = "own-" + field + " — Türkçe"
				}
				values = append(values, v)
				want[field] = v
			}
			if _, err := db.Conn.Exec(`UPDATE users SET display_name=?,avatar_url=?,avatar_animated_url=?,banner_url=?,banner_animated_url=?,wallpaper_url=?,bio=?,pronouns=?,accent_color=?,custom_status=? WHERE id='profile-owner'`, values...); err != nil {
				t.Fatal(err)
			}
			lastSeen := time.Date(2026, 10, 26, 12, 34, 56, 0, time.UTC)
			if _, err := db.Conn.Exec(`UPDATE users SET language='tr',status='online',pref_status='invisible',dm_privacy='friends_only',last_seen_at=? WHERE id='profile-owner'`, lastSeen); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			querier := wrapForRepo(db)
			user, err := NewSQLiteUserRepo(querier).GetByID(ctx, "profile-owner")
			if err != nil {
				t.Fatal(err)
			}
			if !user.IsPlatformAdmin || user.PasswordHash == "" || user.TokenVersion != 7 || user.PlatformBanReason == "" {
				t.Fatal("fixture did not populate excluded sensitive/admin fields")
			}
			want["created_at"] = user.CreatedAt.Format(time.RFC3339Nano)
			repo := NewSQLiteDataExportRepo(querier)
			job, err := repo.Create(ctx, user)
			if err != nil {
				t.Fatal(err)
			}
			payload, err := repo.Download(ctx, user.ID, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(payload, &doc); err != nil {
				t.Fatal(err)
			}
			var account map[string]any
			if err := json.Unmarshal(doc["account"], &account); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(account, want) {
				t.Fatalf("account profile projection differs: got %#v; want %#v", account, want)
			}
			for _, forbidden := range []string{"password_hash", "token_version", "is_platform_admin", "is_platform_banned", "platform_ban_reason", "platform_banned_by", "platform_banned_at", "is_bot", "owner_user_id", "excluded-"} {
				if strings.Contains(string(payload), forbidden) {
					t.Fatalf("export contains excluded field or peer data: %s", forbidden)
				}
			}
			if _, err := repo.Download(ctx, "profile-peer", job.ID); !errors.Is(err, pkg.ErrNotFound) {
				t.Fatalf("peer download: %v", err)
			}
		})
	}
}
