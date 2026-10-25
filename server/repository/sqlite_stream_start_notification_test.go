package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/jackc/pgx/v5/pgconn"
)

func newStreamStartFixture(t *testing.T, actorPreferences, recipientPreferences string) *database.DB {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('stream-actor','streamactor','x'),('stream-friend','streamfriend','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('stream-server','Stream server','stream-actor')`},
		{q: `INSERT INTO server_members(server_id,user_id) VALUES('stream-server','stream-actor'),('stream-server','stream-friend')`},
		{q: `INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES('stream-role','stream-server','stream members',1,4096,1,0),('stream-actor-role','stream-server','stream actor',2,4416,0,0)`},
		{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('stream-actor','stream-actor-role','stream-server'),('stream-friend','stream-role','stream-server')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('stream-channel','Voice','voice','stream-server')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-friendship','stream-actor','stream-friend','accepted')`},
	})
	if actorPreferences != "" {
		if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES('stream-actor',?)`, actorPreferences); err != nil {
			t.Fatal(err)
		}
	}
	if recipientPreferences != "" {
		if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES('stream-friend',?)`, recipientPreferences); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func streamStartRepo(db *database.DB) StreamStartNotificationRepository {
	return NewSQLiteStreamStartNotificationRepo(wrapForRepo(db))
}

func deliverTestStreamStart(t *testing.T, repo StreamStartNotificationRepository) (*models.Notification, error) {
	t.Helper()
	return repo.Deliver(context.Background(), "pub-0123456789abcdef", "server:channel", "track-sid-123", "stream-server", "stream-channel", "stream-actor", "stream-friend", time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))
}

func TestStreamStartDeliveryIsIdempotentAndPayloadHasNoRoomMetadata(t *testing.T) {
	db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
	repo := streamStartRepo(db)
	recipients, err := repo.DueRecipients(context.Background(), "pub-0123456789abcdef", "stream-server", "stream-actor", 200)
	if err != nil || len(recipients) != 1 || recipients[0] != "stream-friend" {
		t.Fatalf("due recipients = %v, %v", recipients, err)
	}
	notification, err := deliverTestStreamStart(t, repo)
	if err != nil || notification == nil {
		t.Fatalf("deliver = %#v, %v", notification, err)
	}
	if notification.ID == "pub-0123456789abcdef" || notification.ActorID == nil || *notification.ActorID != "stream-actor" {
		t.Fatalf("notification identity/actor = %+v", notification)
	}
	var payload map[string]any
	if err := json.Unmarshal(notification.Payload, &payload); err != nil || payload["action"] != "stream_start" || len(payload) != 1 {
		t.Fatalf("notification payload leaks metadata or is invalid: %s (%v)", notification.Payload, err)
	}
	if notification.ServerID != nil || notification.ChannelID != nil {
		t.Fatalf("notification includes channel/server fields: %+v", notification)
	}
	if duplicate, err := deliverTestStreamStart(t, repo); err != nil || duplicate != nil {
		t.Fatalf("duplicate publication delivery = %#v, %v", duplicate, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id='stream-friend'`) != 1 {
		t.Fatal("duplicate publication created multiple decision or notification rows")
	}
	if _, err := db.Conn.Exec(`DELETE FROM notifications WHERE user_id='stream-friend'`); err != nil {
		t.Fatal(err)
	}
	if duplicate, err := deliverTestStreamStart(t, repo); err != nil || duplicate != nil {
		t.Fatalf("deleted publication notification was recreated: %#v, %v", duplicate, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id='stream-friend'`) != 0 {
		t.Fatal("deleting inbox row erased the durable publication decision")
	}
}

func TestStreamStartRetryCandidatesSkipPreviouslyDecidedRecipients(t *testing.T) {
	db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('stream-friend-2','streamfriend2','x')`},
		{q: `INSERT INTO server_members(server_id,user_id) VALUES('stream-server','stream-friend-2')`},
		{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('stream-friend-2','stream-role','stream-server')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-friendship-2','stream-actor','stream-friend-2','accepted')`},
	})
	repo := streamStartRepo(db)
	ctx := context.Background()
	publicationID := "pub-0123456789abcdef"
	recipients, err := repo.DueRecipients(ctx, publicationID, "stream-server", "stream-actor", 200)
	if err != nil || len(recipients) != 2 || recipients[0] != "stream-friend" || recipients[1] != "stream-friend-2" {
		t.Fatalf("initial candidates = %v, %v", recipients, err)
	}
	if _, err := repo.Deliver(ctx, publicationID, "server:channel", "track-sid-123", "stream-server", "stream-channel", "stream-actor", recipients[0], time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	recipients, err = repo.DueRecipients(ctx, publicationID, "stream-server", "stream-actor", 200)
	if err != nil || len(recipients) != 1 || recipients[0] != "stream-friend-2" {
		t.Fatalf("retry candidates = %v, %v; decided recipient was not skipped", recipients, err)
	}
	if _, err := repo.Deliver(ctx, publicationID, "server:channel", "track-sid-123", "stream-server", "stream-channel", "stream-actor", recipients[0], time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 2 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id IN ('stream-friend','stream-friend-2')`) != 2 {
		t.Fatal("retry did not finish the undecided recipient set exactly once")
	}
}

func TestStreamStartConsentAndOptOutDecisionsAreDurable(t *testing.T) {
	t.Run("actor consent must be explicit true", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":false}}`, ``)
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("opted-out actor delivery = %#v, %v", notification, err)
		}
		if _, err := db.Conn.Exec(`UPDATE user_preferences SET data='{"privacy":{"shareStreamUpdates":true}}' WHERE user_id='stream-actor'`); err != nil {
			t.Fatal(err)
		}
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("same publication was replayed after consent change: %#v, %v", notification, err)
		}
		if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
			t.Fatal("actor opt-out decision was not durably recorded")
		}
	})
	t.Run("recipient opt-out", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, `{"notifications":{"streamNotifications":false}}`)
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("opted-out recipient delivery = %#v, %v", notification, err)
		}
		if _, err := db.Conn.Exec(`UPDATE user_preferences SET data='{}' WHERE user_id='stream-friend'`); err != nil {
			t.Fatal(err)
		}
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("same publication was replayed after recipient opt-out changed: %#v, %v", notification, err)
		}
		if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
			t.Fatal("recipient opt-out decision was not durably recorded")
		}
	})
}

func TestStreamStartRequiresCurrentMembershipChannelAndViewPermission(t *testing.T) {
	t.Run("voice-only view permission is sufficient", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification == nil {
			t.Fatalf("view-only member suppressed: %#v, %v", notification, err)
		}
	})
	t.Run("hidden channel", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
		if _, err := db.Conn.Exec(`UPDATE roles SET permissions=0 WHERE id='stream-role'`); err != nil {
			t.Fatal(err)
		}
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("hidden channel delivery = %#v, %v", notification, err)
		}
		if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 {
			t.Fatal("hidden-channel decision wasn't persisted")
		}
	})
	t.Run("wrong channel type", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
		if _, err := db.Conn.Exec(`UPDATE channels SET type='text' WHERE id='stream-channel'`); err != nil {
			t.Fatal(err)
		}
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("text channel delivery = %#v, %v", notification, err)
		}
	})
	t.Run("blocked friendship", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
		if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-block','stream-friend','stream-actor','blocked')`); err != nil {
			t.Fatal(err)
		}
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("blocked friendship delivery = %#v, %v", notification, err)
		}
	})
	t.Run("platform-banned recipient", func(t *testing.T) {
		db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
		if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=1 WHERE id='stream-friend'`); err != nil {
			t.Fatal(err)
		}
		repo := streamStartRepo(db)
		if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
			t.Fatalf("platform-banned recipient delivery = %#v, %v", notification, err)
		}
	})
	for _, tc := range []struct {
		name  string
		setup string
	}{
		{name: "actor stream permission revoked", setup: `UPDATE roles SET permissions=4160 WHERE id='stream-actor-role'`},
		{name: "actor timed out", setup: `INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by) VALUES('stream-server','stream-actor',datetime('now','+1 hour'),'moderator')`},
		{name: "actor banned", setup: `INSERT INTO bans(server_id,user_id,username,banned_by) VALUES('stream-server','stream-actor','streamactor','moderator')`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
			setup := tc.setup
			if database.IsPostgres(db.Conn) && tc.name == "actor timed out" {
				setup = `INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by) VALUES('stream-server','stream-actor',CURRENT_TIMESTAMP + INTERVAL '1 hour','moderator')`
			}
			if _, err := db.Conn.Exec(setup); err != nil {
				t.Fatal(err)
			}
			repo := streamStartRepo(db)
			if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
				t.Fatalf("ineligible actor delivery = %#v, %v", notification, err)
			}
			if countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
				t.Fatal("ineligible actor created a notification")
			}
		})
	}
}

func TestStreamStartFailsClosedWhenServerExceedsRecipientCap(t *testing.T) {
	db := newStreamStartFixture(t, `{"privacy":{"shareStreamUpdates":true}}`, ``)
	for i := 0; i < maxStreamStartServerMembers-1; i++ {
		userID := fmt.Sprintf("stream-extra-%03d", i)
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, userID, userID, "x"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`INSERT INTO server_members(server_id,user_id) VALUES('stream-server',?)`, userID); err != nil {
			t.Fatal(err)
		}
	}
	repo := streamStartRepo(db)
	if recipients, err := repo.DueRecipients(context.Background(), "pub-0123456789abcdef", "stream-server", "stream-actor", 200); err != nil || len(recipients) != 0 {
		t.Fatalf("oversized server candidates = %v, %v", recipients, err)
	}
	if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
		t.Fatalf("oversized server delivery = %#v, %v", notification, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
		t.Fatal("oversized server decision wasn't persisted/fail-closed")
	}
}

func TestStreamStartPostgresAuthorizationLocksBlockWritersUntilRollback(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('stream-actor','streamactor','x'),('stream-friend','streamfriend','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('stream-server','Stream server','stream-actor')`},
		{q: `INSERT INTO server_members(server_id,user_id) VALUES('stream-server','stream-actor'),('stream-server','stream-friend')`},
		{q: `INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES('stream-role','stream-server','stream members',1,4096,1,0),('stream-actor-role','stream-server','stream actor',2,4416,0,0)`},
		{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('stream-actor','stream-actor-role','stream-server'),('stream-friend','stream-role','stream-server')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('stream-channel','Voice','voice','stream-server')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-friendship','stream-actor','stream-friend','accepted')`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('stream-actor','{"privacy":{"shareStreamUpdates":true}}')`},
	})
	raw := database.RawDB(db.Conn)
	ctx := context.Background()
	tx, err := raw.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := lockStreamStartAuthorizationTables(ctx, tx, true); err != nil {
		t.Fatalf("acquire authorization locks: %v", err)
	}
	var guardedTables int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pg_locks l
		JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE l.pid=pg_backend_pid() AND l.granted AND l.mode='ShareLock'
		AND n.nspname=current_schema()
		AND c.relname IN ('bans','channels','channel_permissions','friendships','member_timeouts','roles','server_members','user_roles','account_lifecycle')`).Scan(&guardedTables); err != nil || guardedTables != 9 {
		t.Fatalf("authorization lock set incomplete: count=%d err=%v", guardedTables, err)
	}

	writer, err := raw.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	var writerPID int
	if err := writer.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&writerPID); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	writeDone := make(chan error, 1)
	go func() {
		close(started)
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err := writer.ExecContext(writeCtx, `UPDATE channels SET name='Updated voice' WHERE id='stream-channel'`)
		writeDone <- err
	}()
	<-started
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if err := raw.QueryRowContext(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
			WHERE l.pid=? AND c.oid='channels'::regclass AND l.mode='RowExclusiveLock' AND NOT l.granted
		)`, writerPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("channel writer was not observed waiting behind SHARE authorization lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("channel writer after rollback: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("channel writer remained blocked after rollback released authorization locks")
	}

	if _, err := raw.ExecContext(ctx, `UPDATE roles SET permissions=4160 WHERE id='stream-actor-role'`); err != nil {
		t.Fatal(err)
	}
	repo := streamStartRepo(db)
	if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
		t.Fatalf("revoked actor stream permission still delivered: %#v, %v", notification, err)
	}
}

func TestStreamStartPostgresLockConflictRollsBackDecisionAndRetryRechecks(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('stream-actor','streamactor','x'),('stream-friend','streamfriend','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('stream-server','Stream server','stream-actor')`},
		{q: `INSERT INTO server_members(server_id,user_id) VALUES('stream-server','stream-actor'),('stream-server','stream-friend')`},
		{q: `INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES('stream-role','stream-server','stream members',1,4096,1,0),('stream-actor-role','stream-server','stream actor',2,4416,0,0)`},
		{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('stream-actor','stream-actor-role','stream-server'),('stream-friend','stream-role','stream-server')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('stream-channel','Voice','voice','stream-server')`},
		{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-friendship','stream-actor','stream-friend','accepted')`},
		{q: `INSERT INTO user_preferences(user_id,data) VALUES('stream-actor','{"privacy":{"shareStreamUpdates":true}}')`},
	})
	raw := database.RawDB(db.Conn)
	writerTx, err := raw.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writerTx.Rollback()
	if _, err := writerTx.ExecContext(context.Background(), `UPDATE roles SET permissions=0 WHERE id='stream-role'`); err != nil {
		t.Fatal(err)
	}

	repo := streamStartRepo(db)
	attemptCtx, attemptCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer attemptCancel()
	notification, err := repo.Deliver(attemptCtx, "pub-0123456789abcdef", "stream-server:stream-channel", "track-sid-123", "stream-server", "stream-channel", "stream-actor", "stream-friend", time.Now())
	if err == nil || notification != nil {
		t.Fatalf("delivery during authorization writer should fail promptly: %#v, %v", notification, err)
	}
	var lockErr *pgconn.PgError
	if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
		t.Fatalf("expected NOWAIT lock conflict, not a deadline or deadlock: %v", err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 0 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
		t.Fatal("failed lock attempt left a durable decision or notification")
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := raw.ExecContext(cleanupCtx, `UPDATE channels SET name='Still available' WHERE id='stream-channel'`); err != nil {
		t.Fatalf("failed attempt retained a prefix authorization lock: %v", err)
	}
	if err := writerTx.Commit(); err != nil {
		t.Fatal(err)
	}
	if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
		t.Fatalf("retry after permission revocation = %#v, %v; want durable no-notification decision", notification, err)
	}
	if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
		t.Fatal("retry did not persist only the post-revocation decision")
	}
}

func TestStreamStartPostgresUserAndLifecycleGuardsFailFast(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	for _, tc := range []struct {
		name       string
		writerSQL  string
		writerArgs []any
	}{
		{name: "user status row", writerSQL: `UPDATE users SET is_platform_banned=1 WHERE id='stream-friend'`},
		{name: "account lifecycle insert", writerSQL: `INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES('stream-friend',1,1)`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _ := newPostgresTestDB(t, dsn)
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO users(id,username,password_hash) VALUES('stream-actor','streamactor','x'),('stream-friend','streamfriend','x')`},
				{q: `INSERT INTO servers(id,name,owner_id) VALUES('stream-server','Stream server','stream-actor')`},
				{q: `INSERT INTO server_members(server_id,user_id) VALUES('stream-server','stream-actor'),('stream-server','stream-friend')`},
				{q: `INSERT INTO roles(id,server_id,name,position,permissions,is_default,is_owner) VALUES('stream-role','stream-server','stream members',1,4096,1,0),('stream-actor-role','stream-server','stream actor',2,4416,0,0)`},
				{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('stream-actor','stream-actor-role','stream-server'),('stream-friend','stream-role','stream-server')`},
				{q: `INSERT INTO channels(id,name,type,server_id) VALUES('stream-channel','Voice','voice','stream-server')`},
				{q: `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('stream-friendship','stream-actor','stream-friend','accepted')`},
				{q: `INSERT INTO user_preferences(user_id,data) VALUES('stream-actor','{"privacy":{"shareStreamUpdates":true}}')`},
			})
			raw := database.RawDB(db.Conn)
			writerTx, err := raw.BeginTx(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer writerTx.Rollback()
			if _, err := writerTx.ExecContext(context.Background(), tc.writerSQL, tc.writerArgs...); err != nil {
				t.Fatal(err)
			}

			repo := streamStartRepo(db)
			attemptCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			notification, err := repo.Deliver(attemptCtx, "pub-0123456789abcdef", "stream-server:stream-channel", "track-sid-123", "stream-server", "stream-channel", "stream-actor", "stream-friend", time.Now())
			cancel()
			if err == nil || notification != nil {
				t.Fatalf("delivery during %s writer should fail promptly: %#v, %v", tc.name, notification, err)
			}
			var lockErr *pgconn.PgError
			if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
				t.Fatalf("expected NOWAIT lock conflict, not a deadline or deadlock: %v", err)
			}
			if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 0 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
				t.Fatal("failed lock attempt left a durable decision or notification")
			}
			if err := writerTx.Commit(); err != nil {
				t.Fatal(err)
			}
			if notification, err := deliverTestStreamStart(t, repo); err != nil || notification != nil {
				t.Fatalf("retry after %s revocation = %#v, %v; want no notification", tc.name, notification, err)
			}
			if countRows(t, db, `SELECT COUNT(*) FROM stream_start_deliveries`) != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications`) != 0 {
				t.Fatal("retry did not persist only the post-revocation decision")
			}
		})
	}
}
