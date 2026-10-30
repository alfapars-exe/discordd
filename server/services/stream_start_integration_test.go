package services

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Exercises the real consent/dedupe transaction through the notifier, including
// broadcast-after-commit. Provider transport is tested separately via the SDK.
func TestStreamStartNotifierSQLiteCommittedRealtimeIntegration(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "stream.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, query := range []string{
		`INSERT INTO users(id,username,password_hash) VALUES('publisher','publisher','x'),('friend','friend','x')`,
		`INSERT INTO servers(id,name,owner_id) VALUES('server','Test','publisher')`,
		`INSERT INTO server_members(server_id,user_id) VALUES('server','publisher'),('server','friend')`,
		`INSERT INTO channels(id,name,type,server_id) VALUES('voice','Voice','voice','server')`,
		`INSERT INTO roles(id,server_id,name,position,permissions) VALUES('viewer','server','Viewer',1,4096)`,
		`INSERT INTO roles(id,server_id,name,position,permissions) VALUES('publisher-role','server','Publisher',2,320)`,
		`INSERT INTO user_roles(user_id,role_id,server_id) VALUES('publisher','viewer','server'),('friend','viewer','server')`,
		`INSERT INTO user_roles(user_id,role_id,server_id) VALUES('publisher','publisher-role','server')`,
		`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('relationship','publisher','friend','accepted')`,
		`INSERT INTO user_preferences(user_id,data) VALUES('publisher','{"privacy":{"shareStreamUpdates":true}}')`,
	} {
		if _, err := db.Conn.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	pushed := 0
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(userID string, event ws.Event) {
		if userID != "friend" || event.Op != ws.OpNotificationCreate {
			t.Fatalf("unexpected notification: %s %s", userID, event.Op)
		}
		var committed int
		if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications WHERE user_id='friend'`).Scan(&committed); err != nil || committed != 1 {
			t.Fatalf("broadcast before committed notification: count=%d err=%v", committed, err)
		}
		pushed++
	}}
	repo := repository.NewSQLiteStreamStartNotificationRepo(database.NewRetryingQuerier(db.Conn))
	verifier := &streamVerifierFake{err: ErrScreenShareNotVisible}
	notifier := NewStreamStartNotifier(repo, verifier, hub)
	if err := notifier.NotifyStreamStart(context.Background(), "instance", "server", "voice", "publisher", "server:voice", "TR_publication", time.Now()); !errors.Is(err, ErrScreenShareNotVisible) {
		t.Fatalf("initially invisible provider track must remain retryable: %v", err)
	}
	var decisions int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM stream_start_deliveries`).Scan(&decisions); err != nil || decisions != 0 || pushed != 0 {
		t.Fatalf("provider visibility delay consumed delivery: decisions=%d pushed=%d err=%v", decisions, pushed, err)
	}
	verifier.err = nil
	deliver := func() {
		t.Helper()
		if err := notifier.NotifyStreamStart(context.Background(), "instance", "server", "voice", "publisher", "server:voice", "TR_publication", time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	deliver()
	deliver()
	if pushed != 1 {
		t.Fatalf("duplicate live notification: %d", pushed)
	}
	if _, err := db.Conn.Exec(`DELETE FROM notifications WHERE user_id='friend'`); err != nil {
		t.Fatal(err)
	}
	deliver()
	if pushed != 1 {
		t.Fatalf("deleted notice redelivered: %d", pushed)
	}
}
