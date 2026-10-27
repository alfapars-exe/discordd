package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func newDMDeclineFixture(t *testing.T) (*database.DB, DMRepository, *models.DMChannel, *models.DMMessage) {
	t.Helper()
	db := newDMDeclineFKOffDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusPending)
	if err := repo.SetInitiatedBy(ctx, channel.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	message := newDMMessage(t, ctx, repo, channel.ID, dmAlice, "hello")
	if err := repo.CreateAttachment(ctx, &models.DMAttachment{DMMessageID: message.ID, Filename: "x.png", FileURL: "/api/uploads/x.png"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,dm_channel_id) VALUES('request-n',?,'dm_request',?)`, dmBob, channel.ID); err != nil {
		t.Fatal(err)
	}
	seedDMDeclineDependents(t, db, channel.ID, message.ID)
	return db, repo, channel, message
}

func TestDeclinePendingDeletesAtomicallyAndReturnsPostCommitData(t *testing.T) {
	db, repo, channel, message := newDMDeclineFixture(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO dm_reads(user_id,dm_channel_id) VALUES(?,?)`, dmBob, channel.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO saved_messages(id,user_id,dm_message_id) VALUES('saved-n',?,?)`, dmBob, message.ID); err != nil {
		t.Fatal(err)
	}

	changed, files, ids, err := repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, dmBob)
	if err != nil || !changed {
		t.Fatalf("DeclinePending changed=%v err=%v", changed, err)
	}
	if len(files) != 1 || files[0] != "/api/uploads/x.png" {
		t.Fatalf("file cleanup data = %v", files)
	}
	if len(ids) != 1 || ids[0] != "request-n" {
		t.Fatalf("notification ids = %v", ids)
	}
	for _, check := range []struct {
		query string
		want  int
	}{
		{`SELECT COUNT(*) FROM dm_channels WHERE id=?`, 0},
		{`SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id=?`, 0},
		{`SELECT COUNT(*) FROM dm_attachments WHERE dm_message_id=?`, 0},
		{`SELECT COUNT(*) FROM saved_messages WHERE dm_message_id=?`, 0},
		{`SELECT COUNT(*) FROM dm_reads WHERE dm_channel_id=?`, 0},
		{`SELECT COUNT(*) FROM notifications WHERE dm_channel_id=?`, 0},
		{`SELECT COUNT(*) FROM dm_reactions WHERE dm_message_id=?`, 0},
		{`SELECT COUNT(*) FROM user_dm_settings WHERE dm_channel_id=?`, 0},
		{`SELECT COUNT(*) FROM email_delivery_jobs WHERE dm_message_id=?`, 0},
	} {
		arg := channel.ID
		if strings.Contains(check.query, `dm_message_id=?`) {
			arg = message.ID
		}
		if n := countRows(t, db, check.query, arg); n != check.want {
			t.Errorf("%s count=%d want=%d", check.query, n, check.want)
		}
	}
	changed, files, ids, err = repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, dmBob)
	if err != nil || changed || len(files) != 0 || len(ids) != 0 {
		t.Fatalf("second decline changed=%v files=%v ids=%v err=%v", changed, files, ids, err)
	}
}

func TestDeclinePendingRollsBackAllRowsOnDeleteFailure(t *testing.T) {
	db, repo, channel, message := newDMDeclineFixture(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `CREATE TRIGGER fail_dm_message_delete BEFORE DELETE ON dm_messages BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`); err != nil {
		t.Fatal(err)
	}
	changed, files, ids, err := repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, dmBob)
	if err == nil || changed || len(files) != 0 || len(ids) != 0 {
		t.Fatalf("failed decline returned changed=%v files=%v ids=%v err=%v", changed, files, ids, err)
	}
	for _, check := range []struct {
		query string
		arg   any
	}{
		{`SELECT COUNT(*) FROM dm_channels WHERE id=?`, channel.ID},
		{`SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id=?`, channel.ID},
		{`SELECT COUNT(*) FROM dm_attachments WHERE dm_message_id=?`, message.ID},
		{`SELECT COUNT(*) FROM notifications WHERE id='request-n'`, nil},
		{`SELECT COUNT(*) FROM dm_reactions WHERE dm_message_id=?`, message.ID},
		{`SELECT COUNT(*) FROM user_dm_settings WHERE dm_channel_id=?`, channel.ID},
		{`SELECT COUNT(*) FROM email_delivery_jobs WHERE dm_message_id=?`, message.ID},
	} {
		var n int
		var scanErr error
		if check.arg == nil {
			scanErr = db.Conn.QueryRowContext(ctx, check.query).Scan(&n)
		} else {
			scanErr = db.Conn.QueryRowContext(ctx, check.query, check.arg).Scan(&n)
		}
		if scanErr != nil || n != 1 {
			t.Errorf("after rollback %s count=%d err=%v, want 1", check.query, n, scanErr)
		}
	}
}

func seedDMDeclineDependents(t *testing.T, db *database.DB, channelID, messageID string) {
	t.Helper()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO dm_reactions(id,dm_message_id,user_id,emoji) VALUES('decline-reaction',?,?,?)`, []any{messageID, dmBob, "👍"}},
		{`INSERT INTO user_dm_settings(user_id,dm_channel_id,is_hidden) VALUES(?,?,1)`, []any{dmBob, channelID}},
		{`INSERT INTO email_delivery_jobs(id,user_id,category,dedupe_key,subject,body_html,dm_message_id) VALUES('decline-email',?,'communication','decline-key','subject','body',?)`, []any{dmBob, messageID}},
	} {
		if _, err := db.Conn.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("seed decline dependent: %v", err)
		}
	}
}

func newDMDeclineFKOffDB(t *testing.T) *database.DB {
	t.Helper()
	_, path := newSQLiteTestDBWithPath(t)
	conn, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	conn.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = conn.Close() })
	var foreignKeys int
	if err := conn.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatalf("foreign_keys=%d err=%v; test requires FK enforcement off", foreignKeys, err)
	}
	return &database.DB{Conn: conn}
}

func TestAcceptAndDeclinePendingDMSerialize(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	repo := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusPending)
	if err := repo.SetInitiatedBy(ctx, channel.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type acceptResult struct {
		changed bool
		err     error
	}
	type declineResult struct {
		changed bool
		err     error
	}
	var wg sync.WaitGroup
	wg.Add(2)
	var accepted acceptResult
	var declined declineResult
	go func() {
		defer wg.Done()
		<-start
		accepted.changed, accepted.err = repo.(PendingDMAccepter).AcceptPendingUnblocked(ctx, channel.ID)
	}()
	go func() {
		defer wg.Done()
		<-start
		declined.changed, _, _, declined.err = repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, dmBob)
	}()
	close(start)
	wg.Wait()
	if accepted.err != nil && !errors.Is(accepted.err, context.Canceled) {
		t.Fatalf("accept error: %v", accepted.err)
	}
	if declined.err != nil {
		t.Fatalf("decline error: %v", declined.err)
	}
	if accepted.changed == declined.changed {
		t.Fatalf("exactly one terminal transition must win: accept=%+v decline=%+v", accepted, declined)
	}
	if accepted.changed {
		row, err := repo.GetChannelByID(ctx, channel.ID)
		if err != nil || row.Status != models.DMStatusAccepted {
			t.Fatalf("accepted channel=%+v err=%v", row, err)
		}
	} else if _, err := repo.GetChannelByID(ctx, channel.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("declined channel still exists: err=%v", err)
	}
}

func TestDeclinePendingRemovesDependentsOnConfiguredBackend(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusPending)
	if err := repo.SetInitiatedBy(ctx, channel.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	message := newDMMessage(t, ctx, repo, channel.ID, dmAlice, "hello")
	seedDMDeclineDependents(t, db, channel.ID, message.ID)
	changed, _, _, err := repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, dmBob)
	if err != nil || !changed {
		t.Fatalf("decline changed=%v err=%v", changed, err)
	}
	for _, check := range []struct {
		query string
		arg   string
	}{
		{`SELECT COUNT(*) FROM dm_reactions WHERE dm_message_id=?`, message.ID},
		{`SELECT COUNT(*) FROM email_delivery_jobs WHERE dm_message_id=?`, message.ID},
		{`SELECT COUNT(*) FROM user_dm_settings WHERE dm_channel_id=?`, channel.ID},
	} {
		if n := countRows(t, db, check.query, check.arg); n != 0 {
			t.Errorf("%s count=%d, want 0", check.query, n)
		}
	}
}

