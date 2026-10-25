package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestSQLiteDataExportOwnershipExpiryAndSecretExclusion(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,email) VALUES(?,?,?,?)`, args: []any{"export-alice", "alice", "super-secret-hash", "alice@example.test"}},
		{q: `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, args: []any{"export-bob", "bob", "bob-secret"}},
		{q: `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('export-game','exportgame','game-secret',1,'export-bob'),('other-game','othergame','other-game-secret',1,'export-bob')`},
		{q: `INSERT INTO application_game_identities(bot_user_id) VALUES('export-game'),('other-game')`},
		{q: `INSERT INTO application_game_grants(user_id,bot_user_id,messaging_enabled,revision,authorized_at,updated_at) VALUES('export-alice','export-game',1,2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('export-bob','other-game',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('export-server','Export server','export-bob')`},
		{q: `INSERT INTO server_events(id,server_id,creator_id,name,description,starts_at) VALUES
			('alice-event','export-server','export-alice','Alice event','Alice event description','2026-11-01T12:00:00.000000000Z'),
			('bob-event','export-server','export-bob','Bob event','Bob event description','2026-11-02T12:00:00.000000000Z')`},
		{q: `INSERT INTO server_event_rsvps(event_id,user_id) VALUES('alice-event','export-alice'),('alice-event','export-bob'),('bob-event','export-bob')`},
		{q: `INSERT INTO server_event_deliveries(event_id,user_id,starts_at) VALUES
			('alice-event','export-alice','2026-11-01T12:00:00.000000000Z'),
			('alice-event','export-bob','2026-11-01T12:00:00.000000000Z'),
			('bob-event','export-bob','2026-11-02T12:00:00.000000000Z')`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, args: []any{"export-alice", `{"accessibility":{"chatFontSize":18}}`}},
		{q: `INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label) VALUES('export-alice','dm','private','alice-media-label','original',?,'both'),('export-bob','dm','other','bob-media-label','original',?,'ordinary')`, args: []any{strings.Repeat("a", 64), strings.Repeat("b", 64)}},
		{q: `INSERT INTO spam_inbox(user_id,source_kind,channel_id,message_id,revision,reasons) VALUES('export-alice','dm','private','alice-spam','original','["credential-link"]'),('export-bob','dm','other','bob-private-spam','original','["repeated-links"]')`},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	user := &models.User{ID: "export-alice", Username: "alice", Email: ptrString("alice@example.test"), Language: "tr", CreatedAt: time.Now().UTC()}
	job, err := repo.Create(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "ready" || job.ID == "" || !job.ExpiresAt.After(job.CreatedAt) {
		t.Fatalf("unexpected job: %+v", job)
	}
	payload, err := repo.Download(context.Background(), user.ID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	if !strings.Contains(text, `"game_application_grants"`) || !strings.Contains(text, `"application_id": "export-game"`) || strings.Contains(text, `"application_id": "other-game"`) || strings.Contains(text, "game-secret") {
		t.Fatal("game grant export omitted own grant or leaked another user's grant/credential")
	}
	if !strings.Contains(text, "alice-media-label") || strings.Contains(text, "bob-media-label") {
		t.Fatal("media-label export ownership failed")
	}
	if !strings.Contains(text, "alice-spam") || strings.Contains(text, "bob-private-spam") {
		t.Fatal("spam export ownership failed")
	}
	if !strings.Contains(text, `"authored_server_events"`) || !strings.Contains(text, `"alice-event"`) || strings.Contains(text, `"bob-event"`) {
		t.Fatal("authored event export ownership failed")
	}
	if !strings.Contains(text, `"server_event_rsvps"`) || !strings.Contains(text, `"event_id": "alice-event"`) || strings.Contains(text, "export-bob") {
		t.Fatal("event RSVP export included other attendee identity or omitted own rows")
	}
	if !strings.Contains(text, `"server_event_deliveries"`) || !strings.Contains(text, `"delivered_at"`) || strings.Contains(text, `"notification_id"`) {
		t.Fatal("event delivery export omitted personal delivery history or exposed internal notification linkage")
	}
	if !strings.Contains(text, `"format": "hichat-personal-data-v1"`) || !strings.Contains(text, "chatFontSize") {
		t.Fatalf("incomplete payload: %s", text)
	}
	if strings.Contains(text, "super-secret-hash") || strings.Contains(text, "bob-secret") {
		t.Fatal("authentication secret leaked")
	}
	replacement, err := repo.Create(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	if replacement.ID == job.ID {
		t.Fatal("replacement export reused an identifier")
	}
	if _, err := repo.Get(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("superseded export = %v", err)
	}
	job = replacement
	if _, err := repo.Get(context.Background(), "export-bob", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-owner get = %v", err)
	}
	if _, err := repo.Download(context.Background(), "export-bob", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-owner download = %v", err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_exports SET expires_at=datetime('now','-1 second') WHERE id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Download(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("expired download = %v", err)
	}
}

func ptrString(value string) *string { return &value }

func TestDataExportIncludesOnlyOwnNotificationDecisions(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('notice-a','noticea','x'),('notice-b','noticeb','x')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status,accepted_at) VALUES('notice-f','notice-a','notice-b','accepted','2020-10-24T00:00:00Z')`},
		{q: `INSERT INTO friendship_anniversary_deliveries(friendship_id,anniversary_year,recipient_id) VALUES('notice-f',2026,'notice-a'),('notice-f',2026,'notice-b')`},
		{q: `INSERT INTO stream_start_deliveries(publication_id,recipient_id,actor_id) VALUES('own-publication','notice-a','notice-b'),('foreign-publication','notice-b','notice-a')`},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	job, err := repo.Create(context.Background(), &models.User{ID: "notice-a", Username: "noticea"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := repo.Download(context.Background(), "notice-a", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	var anniversaries, streams []map[string]any
	if err := json.Unmarshal(doc["friendship_anniversary_decisions"], &anniversaries); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(doc["stream_notification_decisions"], &streams); err != nil {
		t.Fatal(err)
	}
	if len(anniversaries) != 1 || len(streams) != 1 || streams[0]["publication_id"] != "own-publication" {
		t.Fatalf("missing own decisions or exported other recipient decisions: %s", payload)
	}
	if _, exposed := streams[0]["recipient_id"]; exposed {
		t.Fatal("unnecessary recipient identifier exposed")
	}
	if _, exposed := streams[0]["notification_id"]; exposed {
		t.Fatal("internal notification linkage exposed")
	}
}
