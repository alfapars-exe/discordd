package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
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

func TestDataExportOwnMusicProjectionAndOpaqueCiphertext(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('export-owner','exportowner','hash'),('export-peer','exportpeer','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('export-music-server','Music','export-peer')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('export-music-channel','Music','voice','export-music-server')`},
		{q: `INSERT INTO music_control_heads(channel_id,server_id,session_id,revision) VALUES('export-music-channel','export-music-server','export-session',9)`},
		{q: `INSERT INTO music_sessions(channel_id,server_id,queue_json,repeat_mode,revision) VALUES('export-music-channel','export-music-server',?,'all',9)`, args: []any{`[{"queue_item_id":"owned-first","video_id":"same-song","requested_by_user_id":"export-owner","requested_by_name":"Owner","future_private":"excluded-future"},{"queue_item_id":"foreign-item","requested_by_user_id":"export-peer","requested_by_name":"Foreign Requester"},{"queue_item_id":"owned-second","video_id":"same-song","requested_by_user_id":"export-owner","requested_by_name":"Owner"}]`}},
		{q: `INSERT INTO music_operation_receipts(channel_id,actor_id,request_id,session_id,request_hash,expected_revision,result_json) VALUES('export-music-channel','export-owner','own-request','export-session','secret-request-hash',8,'{"foreign":"receipt-private-payload"}'),('export-music-channel','export-peer','foreign-request','export-session','foreign-hash',7,'{}')`},
		{q: `INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('export-opaque-dm','export-owner','export-peer')`},
		{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata) VALUES('opaque-own','export-opaque-dm','export-owner',NULL,1,'opaque+/cipher==','device','{"opaque":"metadata"}')`},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	job, err := repo.Create(context.Background(), &models.User{ID: "export-owner"})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := repo.Download(context.Background(), "export-owner", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err = json.Unmarshal(payload, &doc); err != nil {
		t.Fatal(err)
	}
	var queue, ops, dm []map[string]any
	for name, target := range map[string]*[]map[string]any{"own_music_queue_items": &queue, "own_music_operations": &ops, "direct_messages": &dm} {
		if err = json.Unmarshal(doc[name], target); err != nil {
			t.Fatal(err)
		}
	}
	if len(queue) != 2 || queue[0]["queue_index"] != float64(0) || queue[1]["queue_index"] != float64(2) || queue[0]["session_id"] != "export-session" || queue[0]["revision"] != float64(9) {
		t.Fatalf("own queue projection: %s", doc["own_music_queue_items"])
	}
	if len(ops) != 1 || ops[0]["request_id"] != "own-request" {
		t.Fatalf("own receipt projection: %s", doc["own_music_operations"])
	}
	for _, forbidden := range []string{"Foreign Requester", "foreign-item", "foreign-request", "secret-request-hash", "receipt-private-payload", "excluded-future"} {
		if strings.Contains(string(doc["own_music_queue_items"])+string(doc["own_music_operations"]), forbidden) {
			t.Fatalf("music export leaked %s", forbidden)
		}
	}
	if len(dm) != 1 || dm[0]["content"] != nil || dm[0]["ciphertext"] != "opaque+/cipher==" || dm[0]["e2ee_metadata"] != `{"opaque":"metadata"}` {
		t.Fatalf("ciphertext changed: %s", doc["direct_messages"])
	}
}

func TestDataExportDisabledDeletedAndRevokedIdentityGuards(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('export-live','exportlive','hash')`}})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	user := &models.User{ID: "export-live"}
	job, err := repo.Create(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Conn.Exec(`INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES('export-live',?,1)`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.Create(context.Background(), user); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("disabled create: %v", err)
	}
	if _, err = repo.Get(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("disabled get: %v", err)
	}
	if _, err = repo.Download(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("disabled download: %v", err)
	}
	if _, err = db.Conn.Exec(`UPDATE account_lifecycle SET disabled_at=NULL WHERE user_id='export-live'`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Conn.Exec(`UPDATE users SET token_version=token_version+1 WHERE id='export-live'`); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.Create(context.Background(), user); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("revoked identity create: %v", err)
	}
	if _, err = db.Conn.Exec(`UPDATE users SET deleted_at=? WHERE id='export-live'`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.Get(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("deleted get: %v", err)
	}
	if _, err = repo.Download(context.Background(), user.ID, job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("deleted download: %v", err)
	}
}

// This wrapper pauses only RawDB unwrapping: all snapshot rows have been read
// and closed, but the final publication transaction has not acquired its lock.
type gatedExportPublication struct {
	database.TxQuerier
	reached chan struct{}
	release chan struct{}
}

func (q *gatedExportPublication) Unwrap() database.TxQuerier {
	close(q.reached)
	<-q.release
	return q.TxQuerier
}

var _ database.TxQuerier = (*gatedExportPublication)(nil)

func TestDataExportFinalPublicationCannotResurrectDeletedSnapshot(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,email) VALUES('export-retire','exportretire','hash','private@example.invalid')`}})
	session, _ := createLogicalSession(t, NewSQLiteAuthSessionRepo(wrapForRepo(db)), "export-retire", "export-retiring-session", "export-retiring-refresh")
	user := &models.User{ID: "export-retire", Email: ptrString("private@example.invalid"), TokenVersion: session.TokenVersion}
	repo := NewSQLiteDataExportRepo(wrapForRepo(db))
	prior, err := repo.Create(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	gate := &gatedExportPublication{TxQuerier: wrapForRepo(db), reached: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := NewSQLiteDataExportRepo(gate).Create(ctx, user); done <- err }()
	select {
	case <-gate.reached:
	case <-ctx.Done():
		t.Fatal("export never reached final publication")
	}
	if err := NewSQLiteAccountAnonymizationRepo(wrapForRepo(db)).Anonymize(ctx, user.ID, session.ID, "hash", "", time.Now().Unix()); err != nil {
		close(gate.release)
		t.Fatal(err)
	}
	close(gate.release)
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrUnauthorized) {
			t.Fatalf("stale publication: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("export publication did not settle")
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_exports WHERE user_id=?`, user.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("export snapshot survived or was recreated after deletion")
	}
	if _, err := repo.Download(ctx, user.ID, prior.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("retired snapshot readable: %v", err)
	}
}
