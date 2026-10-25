package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestMusicRequesterPrivacyCanonicalEveryQueueWrite(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t).(*sqliteMusicSessionRepo)
	db := database.RawDB(repo.db)
	if _, err := db.Exec(`INSERT INTO users(id,username,password_hash,deleted_at) VALUES('retired','retiredname','!deleted!',1)`); err != nil {
		t.Fatal(err)
	}
	stale := []models.MusicTrack{{QueueItemID: "retired-item", RequestedByUserID: "retired", RequestedByName: "Old private name", Title: "Old private name", URL: "https://youtu.be/0KbRhUtFwkc"}, {QueueItemID: "live-item", RequestedByUserID: "music-actor", RequestedByName: "Old private name", VideoID: "same-title"}}
	session := models.MusicSession{ChannelID: "music-channel", ServerID: "music-server", RepeatMode: "all", Revision: 0, Queue: stale}
	assertQueue := func() {
		t.Helper()
		rows, err := repo.List(ctx)
		if err != nil || len(rows) != 1 {
			t.Fatalf("queue read=%#v %v", rows, err)
		}
		expected := append([]models.MusicTrack(nil), stale...)
		expected[0].RequestedByName = "Deleted User"
		if !reflect.DeepEqual(rows[0].Queue, expected) {
			t.Fatalf("identity or unrelated queue data changed: %#v", rows[0].Queue)
		}
	}
	if err := repo.SaveMusicEnqueue(ctx, session, "music-actor"); err != nil {
		t.Fatal(err)
	}
	assertQueue()
	if err := repo.Save(ctx, session); err != nil {
		t.Fatal(err)
	}
	assertQueue()
	head := models.MusicControlHead{ChannelID: session.ChannelID, ServerID: session.ServerID, SessionID: "session", MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	session.SessionID = head.SessionID
	session.Revision = 1
	head.Revision = 1
	if err := repo.SaveMusicTransition(ctx, head, &session); err != nil {
		t.Fatal(err)
	}
	assertQueue()
	// Equal-revision confirmations compare canonicalized metadata too.
	if err := repo.SaveMusicTransition(ctx, head, &session); err != nil {
		t.Fatalf("canonical equal revision rejected: %v", err)
	}
	command := musicCommit(1, "new-command", "session")
	command.Session.Queue = stale
	if _, _, err := repo.CommitMusicOperation(ctx, command); err != nil {
		t.Fatal(err)
	}
	assertQueue()
	if err := repo.SaveMusicEnqueue(ctx, session, "retired"); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("retired legacy actor=%v", err)
	}
	command = musicCommit(2, "retired-command", "session")
	command.Operation.ActorID = "retired"
	if _, _, err := repo.CommitMusicOperation(ctx, command); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("retired protocol2 actor=%v", err)
	}
}

func TestMusicRequesterPrivacyJSONPreservesUnrelatedBytesAndFields(t *testing.T) {
	raw := `[ {"queue_item_id":"one","requested_by_user_id":"owner","requested_by_name":"Private","title":"Private","unknown":{"array":[1,2]}}, {"requested_by_user_id":"other","requested_by_name":"Private"} ]`
	if got, changed, err := stripMusicRequesterJSON(raw, "absent"); err != nil || changed || got != raw {
		t.Fatalf("unrelated raw JSON changed: %q %v %v", got, changed, err)
	}
	cleaned, changed, err := stripMusicRequesterJSON(raw, "owner")
	if err != nil || !changed {
		t.Fatalf("no anonymization: %v %v", changed, err)
	}
	var before, after []map[string]any
	if json.Unmarshal([]byte(raw), &before) != nil || json.Unmarshal([]byte(cleaned), &after) != nil {
		t.Fatal("invalid JSON")
	}
	before[0]["requested_by_name"] = "Deleted User"
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("unknown fields/order/media changed: %s", cleaned)
	}
	if _, _, err := stripMusicRequesterJSON(`[{broken]`, "owner"); err == nil {
		t.Fatal("corrupt queue silently discarded")
	}
}

func TestMusicRequesterPrivacyConcurrentWriteAndDeletionBounded(t *testing.T) {
	repo := musicControlFixture(t).(*sqliteMusicSessionRepo)
	db := database.RawDB(repo.db)
	if _, err := db.Exec(`INSERT INTO users(id,username,password_hash) VALUES('retiring','privateowner','hash')`); err != nil {
		t.Fatal(err)
	}
	authSession, _ := createLogicalSession(t, NewSQLiteAuthSessionRepo(db), "retiring", "retiring-session", "retiring-refresh")
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "privacy-session", MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(context.Background(), head); err != nil {
		t.Fatal(err)
	}
	tracks := []models.MusicTrack{{QueueItemID: "retired", RequestedByUserID: "retiring", RequestedByName: "Private Name", Title: "Private Name"}, {QueueItemID: "unrelated", RequestedByUserID: "music-actor", RequestedByName: "Private Name"}}
	session := models.MusicSession{ChannelID: head.ChannelID, ServerID: head.ServerID, SessionID: head.SessionID, Revision: 0, RepeatMode: "all", Queue: tracks}
	if err := repo.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	gate, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Rollback()
	if err := lockMusicIdentityTx(ctx, gate, repo.postgres); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 2)
	writeDone, deleteDone := make(chan error, 1), make(chan error, 1)
	head.Revision = 1
	session.Revision = 1
	anon := NewSQLiteAccountAnonymizationRepo(db)
	go func() { started <- struct{}{}; writeDone <- repo.SaveMusicTransition(ctx, head, &session) }()
	go func() {
		started <- struct{}{}
		deleteDone <- anon.Anonymize(ctx, "retiring", authSession.ID, "hash", "", time.Now().Unix())
	}()
	<-started
	<-started
	if err := gate.Commit(); err != nil {
		t.Fatal(err)
	}
	var writeErr, deleteErr error
	select {
	case writeErr = <-writeDone:
	case <-ctx.Done():
		t.Fatal("queue writer deadlocked with account retirement")
	}
	select {
	case deleteErr = <-deleteDone:
	case <-ctx.Done():
		t.Fatal("account retirement deadlocked with queue writer")
	}
	// SQLite may honestly reject a read-to-write snapshot upgrade rather than
	// committing stale data. Exercise one explicit retry after contention; PG
	// uses the shared advisory boundary and must not require this retry.
	isSQLiteBusy := func(err error) bool {
		var coded interface{ Code() int }
		return errors.As(err, &coded) && coded.Code()&255 == 5
	}
	if !repo.postgres && isSQLiteBusy(writeErr) {
		writeErr = repo.SaveMusicTransition(ctx, head, &session)
	}
	if !repo.postgres && isSQLiteBusy(deleteErr) {
		deleteErr = anon.Anonymize(ctx, "retiring", authSession.ID, "hash", "", time.Now().Unix())
	}
	if writeErr != nil || deleteErr != nil {
		t.Fatalf("concurrent music retirement write=%v delete=%v", writeErr, deleteErr)
	}
	rows, err := repo.List(ctx)
	if err != nil || len(rows) != 1 {
		t.Fatalf("queue disappeared: %#v %v", rows, err)
	}
	expected := append([]models.MusicTrack(nil), tracks...)
	expected[0].RequestedByName = "Deleted User"
	if !reflect.DeepEqual(rows[0].Queue, expected) || rows[0].Revision != 1 || rows[0].SessionID != head.SessionID || rows[0].RepeatMode != "all" {
		t.Fatalf("concurrent retirement changed queue semantics: %#v", rows[0])
	}
	got, err := repo.MusicControlHead(ctx, head.ChannelID)
	if err != nil || *got != head {
		t.Fatalf("privacy rewrite changed control head: %#v %v", got, err)
	}
}

func TestMusicRequesterPrivacyEqualRevisionConfirmationAfterAnonymization(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t).(*sqliteMusicSessionRepo)
	db := database.RawDB(repo.db)
	if _, err := db.Exec(`INSERT INTO users(id,username,password_hash) VALUES('retiring','privateowner','hash')`); err != nil {
		t.Fatal(err)
	}
	authSession, _ := createLogicalSession(t, NewSQLiteAuthSessionRepo(db), "retiring", "retiring-session", "retiring-refresh")
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "privacy-session", MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	session := models.MusicSession{ChannelID: head.ChannelID, ServerID: head.ServerID, SessionID: head.SessionID, Revision: 0, RepeatMode: "off", Queue: []models.MusicTrack{{QueueItemID: "same-item", VideoID: "video", Title: "Unchanged", RequestedByUserID: "retiring", RequestedByName: "Private Name"}}}
	if err := repo.Save(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := NewSQLiteAccountAnonymizationRepo(db).Anonymize(ctx, "retiring", authSession.ID, "hash", "", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := db.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='music-channel'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// The account transformer preserves fields but orders object keys differently
	// from encoding/json's MusicTrack struct. Equal means semantic confirmation.
	if err := repo.SaveMusicTransition(ctx, head, &session); err != nil {
		t.Fatalf("unchanged canonical snapshot falsely conflicted: %v", err)
	}
	var after string
	if err := db.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='music-channel'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatal("equal confirmation rewrote queue JSON")
	}
	got, err := repo.MusicControlHead(ctx, head.ChannelID)
	if err != nil || *got != head {
		t.Fatalf("equal confirmation rewrote head: %#v %v", got, err)
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(before), &entries); err != nil {
		t.Fatal(err)
	}
	entries[0]["unknown_precision"] = json.RawMessage(`9007199254740993`)
	raw, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE music_sessions SET queue_json=? WHERE channel_id='music-channel'`, string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveMusicTransition(ctx, head, &session); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("unknown-field erasure accepted: %v", err)
	}
	if err := db.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='music-channel'`).Scan(&after); err != nil || after != string(raw) {
		t.Fatalf("unknown fields rewritten: %s %v", after, err)
	}
	if equal, err := equalMusicQueueJSON([]byte(`[{"n":9007199254740993}]`), []byte(`[{"n":9007199254740992}]`)); err != nil || equal {
		t.Fatal("large integers collapsed by semantic comparison")
	}
}
