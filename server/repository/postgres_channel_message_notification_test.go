package repository

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type postgresChannelBatchResult struct {
	created   []*models.Notification
	committed bool
	err       error
}

func postgresChannelBatchNotifications(ids []string) []*models.Notification {
	rows := make([]*models.Notification, 0, len(ids))
	for _, id := range ids {
		rows = append(rows, &models.Notification{UserID: id})
	}
	return rows
}

func startPostgresChannelBatchCommit(ctx context.Context, queue ChannelMessageNotificationQueue, job *ChannelMessageNotificationJob, ids []string, eligible []*models.Notification) <-chan postgresChannelBatchResult {
	finished := make(chan postgresChannelBatchResult, 1)
	go func() {
		created, committed, err := queue.CommitBatch(ctx, job, ids[len(ids)-1], true, eligible)
		finished <- postgresChannelBatchResult{created: created, committed: committed, err: err}
	}()
	return finished
}

// Assert the queue worker cannot pass an in-flight policy/cascade writer, then
// release it and return its result. A direct assertion that the worker waits
// is important: checking only the final rows would miss an unsafe early send.
func finishPostgresChannelWriterRace(t *testing.T, writer *sql.Tx, finished <-chan postgresChannelBatchResult, description string) postgresChannelBatchResult {
	t.Helper()
	select {
	case result := <-finished:
		_ = writer.Rollback()
		t.Fatalf("fanout bypassed in-flight %s writer: %#v", description, result)
	case <-time.After(100 * time.Millisecond):
	}
	if err := writer.Commit(); err != nil {
		t.Fatalf("commit %s writer: %v", description, err)
	}
	select {
	case result := <-finished:
		return result
	case <-time.After(5 * time.Second):
		t.Fatalf("fanout did not resume after %s writer committed", description)
		return postgresChannelBatchResult{}
	}
}

func postgresChannelQueuePage(t *testing.T, ctx context.Context, queue ChannelMessageNotificationQueue, msg *models.Message) (*ChannelMessageNotificationJob, []string) {
	t.Helper()
	if err := queue.Enqueue(ctx, msg.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	job, ids, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || len(ids) != 2 {
		t.Fatalf("queue page: %#v %#v %v", job, ids, err)
	}
	return job, ids
}

// The queue is created over *sql.Tx in MessageTxRunner. Dialect selection must
// come from the parent *sql.DB because the transaction itself is opaque.
func TestPostgresMessageTxChannelNotificationEnqueueUsesDialect(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, _, _ := channelQueueFixture(t)
	content := "plaintext source must not enter the queue"
	message := &models.Message{ChannelID: msgChannel, UserID: msgAuthor, Content: &content}
	err := NewMessageTxRunner(db.Conn).InTx(ctx, func(repos *MessageTxRepos) error {
		if err := repos.Message.Create(ctx, message); err != nil {
			return err
		}
		return repos.ChannelMessageNotifications.Enqueue(ctx, message.ID, "srv-1", msgChannel, msgAuthor)
	})
	if err != nil {
		t.Fatalf("PostgreSQL message tx enqueue: %v", err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM channel_message_notification_jobs WHERE message_id=?`, message.ID); got != 1 {
		t.Fatalf("transactional queue rows=%d, want 1", got)
	}
}

func TestPostgresChannelNotificationWritersSharePolicyFence(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	tests := []struct {
		name  string
		write func(context.Context, *sql.Tx) error
	}{
		{"opt-out", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE user_preferences SET data=? WHERE user_id=?`, `{"notifications":{"channelMessageNotifications":false}}`, msgSecondUser)
			return err
		}},
		{"channel-mute", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO channel_mutes(user_id,channel_id,server_id) VALUES(?,?,?)`, msgSecondUser, msgChannel, "srv-1")
			return err
		}},
		{"server-mute", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO server_mutes(user_id,server_id) VALUES(?,?)`, msgSecondUser, "srv-1")
			return err
		}},
		{"block", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO friendships(id,user_id,friend_id,status) VALUES('block-race',?,?, 'blocked')`, msgSecondUser, msgAuthor)
			return err
		}},
		{"role-permission-change", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE roles SET permissions=0 WHERE id='reader'`)
			return err
		}},
		{"role-assignment-removal", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `DELETE FROM user_roles WHERE user_id=? AND role_id='reader'`, msgSecondUser)
			return err
		}},
		{"member-leave", func(ctx context.Context, tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `DELETE FROM server_members WHERE server_id='srv-1' AND user_id=?`, msgSecondUser)
			return err
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db, ctx, queue, msg := channelQueueFixture(t)
			if !database.IsPostgres(db.Conn) {
				t.Skip("requires PostgreSQL transaction fencing")
			}
			if _, err := db.Conn.Exec(`INSERT INTO roles(id,name,server_id,permissions) VALUES('reader','Reader','srv-1',6144)`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?, 'reader','srv-1')`, msgSecondUser); err != nil {
				t.Fatal(err)
			}
			job, ids := postgresChannelQueuePage(t, ctx, queue, msg)
			writer, err := db.Conn.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := tc.write(ctx, writer); err != nil {
				_ = writer.Rollback()
				t.Fatal(err)
			}

			result := finishPostgresChannelWriterRace(t, writer,
				startPostgresChannelBatchCommit(ctx, queue, job, ids, postgresChannelBatchNotifications(ids)), tc.name)
			if result.err != nil || !result.committed || len(result.created) != 0 {
				t.Fatalf("fanout result after %s: %#v", tc.name, result)
			}
			if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID); got != 0 {
				t.Fatalf("%s race delivered %d notification(s)", tc.name, got)
			}
		})
	}
}

func TestPostgresChannelNotificationFreshSnapshotAfterConcurrentOverrideInsert(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, queue, msg := channelQueueFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires PostgreSQL ACL fencing")
	}
	if _, err := db.Conn.Exec(`INSERT INTO roles(id,name,server_id,permissions) VALUES('reader','Reader','srv-1',6144)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?, 'reader','srv-1')`, msgSecondUser); err != nil {
		t.Fatal(err)
	}
	job, ids := postgresChannelQueuePage(t, ctx, queue, msg)

	// This override row did not exist at fanout page-read time, so row locks
	// cannot protect it. Its trigger must hold the shared server gate.
	writer, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.ExecContext(ctx, `INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES(?, 'reader',0,2048)`, msgChannel); err != nil {
		_ = writer.Rollback()
		t.Fatal(err)
	}
	result := finishPostgresChannelWriterRace(t, writer,
		startPostgresChannelBatchCommit(ctx, queue, job, ids, postgresChannelBatchNotifications(ids)), "ACL deny override")
	if result.err != nil || !result.committed || len(result.created) != 0 {
		t.Fatalf("fanout result after deny override: %#v", result)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID); got != 0 {
		t.Fatalf("new private ACL deny leaked %d notification(s)", got)
	}
}

func TestPostgresChannelNotificationRetirementBarrierPrecedesRecipientFences(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, queue, msg := channelQueueFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires PostgreSQL retirement barrier")
	}
	job, ids := postgresChannelQueuePage(t, ctx, queue, msg)
	retirement, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := retirement.ExecContext(ctx, `UPDATE users SET deleted_at=EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::BIGINT WHERE id=?`, msgSecondUser); err != nil {
		_ = retirement.Rollback()
		t.Fatal(err)
	}
	result := finishPostgresChannelWriterRace(t, retirement,
		startPostgresChannelBatchCommit(ctx, queue, job, ids, postgresChannelBatchNotifications(ids)), "PG005 account retirement")
	if result.err != nil || !result.committed || len(result.created) != 0 {
		t.Fatalf("fanout result after retirement: %#v", result)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID); got != 0 {
		t.Fatalf("retired recipient received %d notification(s)", got)
	}
}

func TestPostgresChannelDeleteAndNotificationFanoutUseFenceOrder(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, queue, msg := channelQueueFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires PostgreSQL cascade fencing")
	}
	if _, err := db.Conn.Exec(`INSERT INTO channel_mutes(user_id,channel_id,server_id) VALUES(?,?,?)`, msgSecondUser, msgChannel, "srv-1"); err != nil {
		t.Fatal(err)
	}
	job, ids := postgresChannelQueuePage(t, ctx, queue, msg)
	deletion, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deletion.ExecContext(ctx, `DELETE FROM channels WHERE id=?`, msgChannel); err != nil {
		_ = deletion.Rollback()
		t.Fatal(err)
	}
	result := finishPostgresChannelWriterRace(t, deletion,
		startPostgresChannelBatchCommit(ctx, queue, job, ids, postgresChannelBatchNotifications(ids)), "channel/mute cascade")
	if (result.err != nil && !errors.Is(result.err, sql.ErrNoRows)) || result.committed || len(result.created) != 0 {
		t.Fatalf("deleted channel produced notification result: %#v", result)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID); got != 0 {
		t.Fatalf("deleted channel left %d notification(s)", got)
	}
}

func TestPostgresServerCascadeAndNotificationFanoutUseFenceOrder(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, queue, msg := channelQueueFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires PostgreSQL cascade fencing")
	}
	job, ids := postgresChannelQueuePage(t, ctx, queue, msg)
	// Pause the cascade after its first queue-row DELETE. The cascade must
	// already own the shared retirement barrier and server fence at this point;
	// fanout therefore waits on the server fence instead of owning it while
	// waiting on the queue row (the historical deadlock order).
	const pauseKey = int64(9138271)
	blocker, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.ExecContext(ctx, `SELECT pg_advisory_xact_lock(?)`, pauseKey); err != nil {
		_ = blocker.Rollback()
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `CREATE FUNCTION p11_pause_server_queue_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(9138271); RETURN OLD; END $$`); err != nil {
		_ = blocker.Rollback()
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `CREATE TRIGGER p11_pause_server_queue_delete BEFORE DELETE ON channel_message_notification_jobs FOR EACH ROW EXECUTE FUNCTION p11_pause_server_queue_delete()`); err != nil {
		_ = blocker.Rollback()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Conn.ExecContext(context.Background(), `DROP TRIGGER IF EXISTS p11_pause_server_queue_delete ON channel_message_notification_jobs`)
		_, _ = db.Conn.ExecContext(context.Background(), `DROP FUNCTION IF EXISTS p11_pause_server_queue_delete()`)
	})
	type result struct{ err error }
	deleted := make(chan result, 1)
	go func() {
		deleted <- result{database.WithTx(ctx, db.Conn, func(tx *sql.Tx) error {
			return NewSQLiteServerRepoWithDialect(tx, true).Delete(ctx, "srv-1")
		})}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=? AND NOT granted)`, pauseKey).Scan(&waiting); err != nil {
			_ = blocker.Rollback()
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			_ = blocker.Rollback()
			t.Fatal("server cascade did not reach the queue-row pause trigger")
		}
		time.Sleep(10 * time.Millisecond)
	}
	fanout := make(chan struct {
		committed bool
		err       error
	}, 1)
	go func() {
		_, committed, err := queue.CommitBatch(ctx, job, ids[len(ids)-1], true,
			[]*models.Notification{{UserID: ids[0]}})
		fanout <- struct {
			committed bool
			err       error
		}{committed, err}
	}()
	// Confirm fanout is queued specifically on the held server advisory fence,
	// then let cascade continue. Both transactions must finish without
	// SQLSTATE 40P01.
	deadline = time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_locks
			WHERE locktype='advisory' AND NOT granted
			AND classid=((hashtextextended('srv-1',0) >> 32) & 4294967295)::oid
			AND objid=(hashtextextended('srv-1',0) & 4294967295)::oid
		)`).Scan(&waiting); err != nil {
			_ = blocker.Rollback()
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			_ = blocker.Rollback()
			t.Fatal("fanout did not wait for cascade's server fence")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-deleted:
		if r.err != nil {
			t.Fatalf("server cascade: %v", r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server cascade deadlocked with notification fanout")
	}
	select {
	case r := <-fanout:
		if r.err != nil {
			t.Fatalf("notification fanout: %v", r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("notification fanout did not resume after server cascade")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM channel_message_notification_jobs WHERE server_id='srv-1'`); got != 0 {
		t.Fatalf("server cascade left %d queue jobs", got)
	}
}

func TestPostgresOverlappingRecipientPagesUseDeterministicLockOrder(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, ctx, queue, first := channelQueueFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires PostgreSQL advisory gates")
	}
	if _, err := db.Conn.Exec(`INSERT INTO servers(id,name,owner_id) VALUES('srv-2','test-2',?)`, msgAuthor); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO channels(id,name,type,server_id) VALUES('chan-2','other','text','srv-2')`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{msgAuthor, msgSecondUser, "u-no-view"} {
		if _, err := db.Conn.Exec(`INSERT INTO server_members(server_id,user_id) VALUES('srv-2',?)`, id); err != nil {
			t.Fatal(err)
		}
	}
	second := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), "chan-2", msgAuthor, "second server message")
	if err := queue.Enqueue(ctx, first.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(ctx, second.ID, "srv-2", "chan-2", msgAuthor); err != nil {
		t.Fatal(err)
	}
	jobs := make([]*ChannelMessageNotificationJob, 0, 2)
	for _, id := range []string{first.ID, second.ID} {
		job := &ChannelMessageNotificationJob{}
		if err := db.Conn.QueryRow(`SELECT message_id,server_id,channel_id,actor_id,cursor_user_id,last_batch_at FROM channel_message_notification_jobs WHERE message_id=?`, id).
			Scan(&job.MessageID, &job.ServerID, &job.ChannelID, &job.ActorID, &job.CursorUserID, &job.LastBatchAt); err != nil {
			t.Fatal(err)
		}
		jobs = append(jobs, job)
	}
	eligible := []*models.Notification{{UserID: "u-no-view"}, {UserID: msgSecondUser}}
	start := make(chan struct{})
	type result struct {
		committed bool
		err       error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for _, job := range jobs {
		wg.Add(1)
		go func(j *ChannelMessageNotificationJob) {
			defer wg.Done()
			<-start
			_, committed, err := queue.CommitBatch(ctx, j, msgSecondUser, true, eligible)
			results <- result{committed, err}
		}(job)
	}
	close(start)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("overlapping server pages deadlocked on recipient gates")
	}
	close(results)
	for r := range results {
		if r.err != nil || !r.committed {
			t.Fatalf("overlapping page commit: %#v", r)
		}
	}
}
