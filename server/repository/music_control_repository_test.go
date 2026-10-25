package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func musicControlFixture(t *testing.T) MusicControlRepository {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('music-actor','musicactor','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('music-server','Music','music-actor')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('music-channel','Music','voice','music-server')`},
	})
	return NewSQLiteMusicSessionRepo(db.Conn).(MusicControlRepository)
}

func musicCommit(revision uint64, request, session string) models.MusicOperationCommit {
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: session, Revision: revision + 1, MinimumProtocol: 2}
	return models.MusicOperationCommit{
		Operation: models.MusicOperation{ActorID: "music-actor", ChannelID: head.ChannelID, SessionID: session, RequestID: request, RequestHash: strings.Repeat("a", 64), ExpectedRevision: revision},
		NextHead:  head,
		Session:   &models.MusicSession{SessionID: session, ChannelID: head.ChannelID, ServerID: head.ServerID, Revision: head.Revision, RepeatMode: "off", Queue: []models.MusicTrack{{QueueItemID: request, URL: "https://www.youtube.com/watch?v=0KbRhUtFwkc"}}},
		Result:    json.RawMessage(`{"status":"ok"}`),
	}
}

func TestMusicControlAtomicRetryAndReplacement(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t)
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "session-one", Revision: 7, MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	// Repeated adoption cannot reset the live revision or session.
	reset := head
	reset.SessionID = "malicious-reset"
	reset.Revision = 0
	if got, err := repo.AdoptMusicControl(ctx, reset); err != nil || got != head {
		t.Fatalf("adoption reset: %#v %v", got, err)
	}
	add := musicCommit(7, "first-add", head.SessionID)
	if _, replay, err := repo.CommitMusicOperation(ctx, add); err != nil || replay {
		t.Fatalf("first commit replay=%v err=%v", replay, err)
	}
	if _, replay, err := repo.CommitMusicOperation(ctx, add); err != nil || !replay {
		t.Fatalf("exact retry replay=%v err=%v", replay, err)
	}
	changed := add
	changed.Operation.RequestHash = strings.Repeat("b", 64)
	if _, _, err := repo.CommitMusicOperation(ctx, changed); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed payload=%v", err)
	}
	// Identical URLs with distinct request IDs are intentional additions.
	second := musicCommit(8, "second-add", head.SessionID)
	if _, replay, err := repo.CommitMusicOperation(ctx, second); err != nil || replay {
		t.Fatalf("intentional duplicate replay=%v err=%v", replay, err)
	}
	stop := musicCommit(9, "stop-once", head.SessionID)
	stop.Session = nil
	stop.NextHead.SessionID = "replacement"
	if _, _, err := repo.CommitMusicOperation(ctx, stop); err != nil {
		t.Fatal(err)
	}
	if _, replay, err := repo.CommitMusicOperation(ctx, stop); err != nil || !replay {
		t.Fatalf("stop retry=%v %v", replay, err)
	}
	if got, _ := repo.MusicControlHead(ctx, head.ChannelID); got.SessionID != "replacement" || got.Revision != 10 {
		t.Fatalf("retry touched replacement: %#v", got)
	}
	freshStale := musicCommit(9, "fresh-stale", head.SessionID)
	if _, _, err := repo.CommitMusicOperation(ctx, freshStale); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale session=%v", err)
	}
}

func TestMusicControlReceiptFailureRollsBackQueueAndHead(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t)
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "session", Revision: 0, MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	command := musicCommit(0, "request", "session")
	// Queue save succeeds first; the unknown actor then violates the receipt
	// FK. The transaction must roll back both the queue and head update.
	command.Operation.ActorID = "missing-actor"
	if _, _, err := repo.CommitMusicOperation(ctx, command); err == nil {
		t.Fatal("missing receipt actor accepted")
	}
	got, err := repo.MusicControlHead(ctx, head.ChannelID)
	if err != nil || *got != head {
		t.Fatalf("head changed: %#v %v", got, err)
	}
	rows, err := repo.(MusicSessionRepository).List(ctx)
	if err != nil || len(rows) != 0 {
		t.Fatalf("queue survived failed receipt: %#v %v", rows, err)
	}
	command.Operation.ActorID = "music-actor"
	if _, replay, err := repo.CommitMusicOperation(ctx, command); err != nil || replay {
		t.Fatalf("retry after rollback: %v %v", replay, err)
	}
}

func TestMusicControlRetiredPublisherCannotOverwriteReplacement(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t)
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "old-session", Revision: 0, MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	stop := musicCommit(0, "stop", "old-session")
	stop.Session = nil
	stop.NextHead.SessionID = "new-session"
	if _, _, err := repo.CommitMusicOperation(ctx, stop); err != nil {
		t.Fatal(err)
	}
	head.Revision = 20
	if err := repo.SaveMusicTransition(ctx, head, nil); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("retired write=%v", err)
	}
	got, _ := repo.MusicControlHead(ctx, head.ChannelID)
	if got.SessionID != "new-session" || got.Revision != 1 {
		t.Fatalf("retired write changed head: %#v", got)
	}
}

func TestMusicControlSameRevisionSnapshotCannotOverwriteQueue(t *testing.T) {
	ctx := context.Background()
	repo := musicControlFixture(t)
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "session", MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(ctx, head); err != nil {
		t.Fatal(err)
	}
	command := musicCommit(0, "enqueue", "session")
	if _, _, err := repo.CommitMusicOperation(ctx, command); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveMusicTransition(ctx, command.NextHead, command.Session); err != nil {
		t.Fatalf("identical snapshot rejected: %v", err)
	}
	stale := *command.Session
	stale.Queue = []models.MusicTrack{{QueueItemID: "different"}}
	if err := repo.SaveMusicTransition(ctx, command.NextHead, &stale); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("same-revision overwrite=%v", err)
	}
	if err := repo.SaveMusicTransition(ctx, command.NextHead, nil); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("same-revision delete=%v", err)
	}
	wrong := musicCommit(1, "next", "session")
	wrong.Session.SessionID = "other-session"
	if _, _, err := repo.CommitMusicOperation(ctx, wrong); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("mismatched session=%v", err)
	}
}

func TestMusicControlServerDeletionCleansReceiptsWithFKsOff(t *testing.T) {
	db, path := newTestDBWithPath(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('music-actor','musicactor','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('music-server','Music','music-actor'),('other-server','Other','music-actor')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('music-channel','Music','voice','music-server'),('other-channel','Other','voice','other-server')`},
	})
	repo := NewSQLiteMusicSessionRepo(db.Conn).(MusicControlRepository)
	head := models.MusicControlHead{ChannelID: "music-channel", ServerID: "music-server", SessionID: "session", MinimumProtocol: 2}
	if _, err := repo.AdoptMusicControl(context.Background(), head); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.CommitMusicOperation(context.Background(), musicCommit(0, "first", "session")); err != nil {
		t.Fatal(err)
	}
	other := head
	other.ChannelID = "other-channel"
	other.ServerID = "other-server"
	if _, err := repo.AdoptMusicControl(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	if err := deleteServerCascade(context.Background(), entranceFKOffConn(t, path), "music-server"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"music_operation_receipts", "music_sessions"} {
		var n int
		query := `SELECT COUNT(*) FROM music_operation_receipts`
		if table == "music_sessions" {
			query = `SELECT COUNT(*) FROM music_sessions`
		}
		if err := db.Conn.QueryRow(query).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s remains: n=%d err=%v", table, n, err)
		}
	}
	if got, err := repo.MusicControlHead(context.Background(), "music-channel"); err != nil || got != nil {
		t.Fatalf("deleted server head=%#v %v", got, err)
	}
	if got, err := repo.MusicControlHead(context.Background(), "other-channel"); err != nil || got == nil {
		t.Fatalf("unrelated head removed=%#v %v", got, err)
	}
}
