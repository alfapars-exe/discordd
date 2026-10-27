package repository

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func channelQueueFixture(t *testing.T) (*database.DB, context.Context, *sqliteChannelMessageNotificationQueue, *models.Message) {
	t.Helper()
	db := newTestDB(t)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users(id,username,password_hash) VALUES(?,?, 'x'),(?,?, 'x'),(?,?, 'x')`, []any{msgAuthor, "author", msgSecondUser, "second", "u-no-view", "no-view"}},
		{`INSERT INTO servers(id,name,owner_id) VALUES('srv-1','test',?)`, []any{msgAuthor}},
		{`INSERT INTO channels(id,name,type,server_id) VALUES(?, 'general','text','srv-1')`, []any{msgChannel}},
		{`INSERT INTO server_members(server_id,user_id) VALUES('srv-1',?),('srv-1',?),('srv-1','u-no-view')`, []any{msgAuthor, msgSecondUser}},
		{`INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, []any{msgSecondUser, `{"notifications":{"channelMessageNotifications":true}}`}},
		{`INSERT INTO user_preferences(user_id,data) VALUES('u-no-view',?)`, []any{`{"notifications":{"channelMessageNotifications":true}}`}},
	})
	msg := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), msgChannel, msgAuthor, "body must not be copied")
	queue := NewSQLiteChannelMessageNotificationQueue(db.Conn).(*sqliteChannelMessageNotificationQueue)
	return db, ctx, queue, msg
}

func TestChannelMessageNotificationRetryBackoffDoesNotStarveReadyJobs(t *testing.T) {
	db, ctx, queue, first := channelQueueFixture(t)
	if err := queue.Enqueue(ctx, first.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	job, _, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || job.MessageID != first.ID {
		t.Fatalf("first job: %#v %v", job, err)
	}
	if err := queue.FailBatch(ctx, job); err != nil {
		t.Fatal(err)
	}
	second := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), msgChannel, msgAuthor, "another body")
	if err := queue.Enqueue(ctx, second.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	job, _, err = queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || job.MessageID != second.ID {
		t.Fatalf("ready job starved behind retry: %#v %v", job, err)
	}
	if got := countRows(t, db, `SELECT attempt_count FROM channel_message_notification_jobs WHERE message_id=?`, first.ID); got != 1 {
		t.Fatalf("failed job attempts=%d, want 1", got)
	}
	if _, err := db.Conn.Exec(`UPDATE channel_message_notification_jobs SET next_attempt_at='2000-01-01 00:00:00' WHERE message_id=?`, first.ID); err != nil {
		t.Fatal(err)
	}
	retry, _, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || retry == nil || retry.MessageID != first.ID || retry.CursorUserID != "" {
		t.Fatalf("failed page was lost instead of retried from its cursor: %#v %v", retry, err)
	}
}

func TestChannelMessageNotificationCommitRechecksPrivateChannelACL(t *testing.T) {
	db, ctx, queue, msg := channelQueueFixture(t)
	if _, err := db.Conn.Exec(`INSERT INTO roles(id,name,server_id,permissions) VALUES('reader','Reader','srv-1',6144)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?, 'reader','srv-1')`, msgSecondUser); err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(ctx, msg.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	job, ids, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || len(ids) != 2 || ids[0] != "u-no-view" || ids[1] != msgSecondUser {
		t.Fatalf("next page: %#v %#v %v", job, ids, err)
	}
	// Revoke read permission after page selection but before the atomic insert.
	if _, err := db.Conn.Exec(`INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES(?, 'reader',0,2048)`, msgChannel); err != nil {
		t.Fatal(err)
	}
	notifications := []*models.Notification{{UserID: ids[0]}, {UserID: ids[1]}}
	created, committed, err := queue.CommitBatch(ctx, job, ids[1], true, notifications)
	if err != nil || !committed {
		t.Fatalf("commit=%v created=%#v err=%v", committed, created, err)
	}
	if len(created) != 0 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID) != 0 {
		t.Fatalf("revoked private channel read access leaked notification: %#v", created)
	}
}

func TestChannelMessageNotificationConcurrentWorkersCommitPageOnce(t *testing.T) {
	db, ctx, queue, msg := channelQueueFixture(t)
	if _, err := db.Conn.Exec(`INSERT INTO roles(id,name,server_id,permissions) VALUES('reader','Reader','srv-1',6144)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?, 'reader','srv-1')`, msgSecondUser); err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(ctx, msg.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	job1, ids1, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job1 == nil || len(ids1) != 2 {
		t.Fatalf("first worker page: %#v %#v %v", job1, ids1, err)
	}
	job2, ids2, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job2 == nil || job2.LastBatchAt != job1.LastBatchAt || len(ids2) != 2 {
		t.Fatalf("second worker page: %#v %#v %v", job2, ids2, err)
	}
	eligible := []*models.Notification{{UserID: ids1[0]}, {UserID: ids1[1]}}
	start := make(chan struct{})
	type result struct {
		created   []*models.Notification
		committed bool
		err       error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for _, job := range []*ChannelMessageNotificationJob{job1, job2} {
		wg.Add(1)
		go func(j *ChannelMessageNotificationJob) {
			defer wg.Done()
			<-start
			created, committed, err := queue.CommitBatch(ctx, j, ids1[len(ids1)-1], true, eligible)
			results <- result{created: created, committed: committed, err: err}
		}(job)
	}
	close(start)
	wg.Wait()
	close(results)
	commits, createdTotal := 0, 0
	for r := range results {
		if r.err != nil { // A serialization/lock conflict is retried by the durable worker.
			continue
		}
		if r.committed {
			commits++
		}
		createdTotal += len(r.created)
	}
	if commits != 1 || createdTotal != 1 || countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID) != 1 {
		t.Fatalf("CAS failed to serialize duplicate worker page: commits=%d created=%d persisted=%d", commits, createdTotal,
			countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, msg.ID))
	}
}

func TestChannelMessageNotificationLargeFanoutPagesDeliverEveryRecipientOnce(t *testing.T) {
	db, ctx, queue, first := channelQueueFixture(t)
	seed := make([]seedStmt, 0, 205*3)
	for i := 0; i < 205; i++ {
		id := fmt.Sprintf("u-batch-%03d", i)
		seed = append(seed,
			seedStmt{`INSERT INTO users(id,username,password_hash) VALUES(?,?, 'x')`, []any{id, id}},
			seedStmt{`INSERT INTO server_members(server_id,user_id) VALUES('srv-1',?)`, []any{id}},
			seedStmt{`INSERT INTO user_preferences(user_id,data) VALUES(?,?)`, []any{id, `{"notifications":{"channelMessageNotifications":true}}`}},
		)
	}
	execSeed(t, db, seed)
	second := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), msgChannel, msgAuthor, "second message")
	if err := queue.Enqueue(ctx, first.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	if err := queue.Enqueue(ctx, second.ID, "srv-1", msgChannel, msgAuthor); err != nil {
		t.Fatal(err)
	}
	seen := map[string]map[string]int{first.ID: {}, second.ID: {}}
	expectedRecipients := 205 + 2 // seeded opt-ins plus fixture recipients
	for pages := 0; pages < 12; pages++ {
		job, ids, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
		if err != nil {
			t.Fatalf("next page: %v", err)
		}
		if job == nil {
			break
		}
		if _, ok := seen[job.MessageID]; !ok {
			t.Fatalf("unexpected job %q", job.MessageID)
		}
		if len(ids) == 0 || len(ids) > ChannelMessageNotificationBatchSize {
			t.Fatalf("invalid page size %d for job %s", len(ids), job.MessageID)
		}
		for _, id := range ids {
			seen[job.MessageID][id]++
		}
		done := len(ids) < ChannelMessageNotificationBatchSize
		if _, committed, err := queue.CommitBatch(ctx, job, ids[len(ids)-1], done, nil); err != nil || !committed {
			t.Fatalf("commit %s page: committed=%v err=%v", job.MessageID, committed, err)
		}
	}
	for _, messageID := range []string{first.ID, second.ID} {
		if got := len(seen[messageID]); got != expectedRecipients {
			t.Fatalf("job %s delivered to %d unique recipients, want %d", messageID, got, expectedRecipients)
		}
		for userID, count := range seen[messageID] {
			if count != 1 {
				t.Errorf("job %s delivered recipient %s %d times", messageID, userID, count)
			}
		}
	}
	if job, ids, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize); err != nil || job != nil || len(ids) != 0 {
		t.Fatalf("completed fanout left work: %#v %#v %v", job, ids, err)
	}
}

func TestChannelMessageNotificationEqualTimestampsBreakTiesDeterministicallyAndProgress(t *testing.T) {
	db, ctx, queue, first := channelQueueFixture(t)
	second := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), msgChannel, msgAuthor, "second body")
	for _, message := range []*models.Message{first, second} {
		if err := queue.Enqueue(ctx, message.ID, "srv-1", msgChannel, msgAuthor); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`UPDATE channel_message_notification_jobs SET created_at='2000-01-01 00:00:00',last_batch_at='2000-01-01 00:00:00' WHERE message_id=?`, message.ID); err != nil {
			t.Fatal(err)
		}
	}
	wantFirst := first.ID
	wantSecond := second.ID
	if wantSecond < wantFirst {
		wantFirst, wantSecond = wantSecond, wantFirst
	}
	job, ids, err := queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || job.MessageID != wantFirst || len(ids) != 2 {
		t.Fatalf("equal timestamp tie chose %#v with %d recipients, want %s: %v", job, len(ids), wantFirst, err)
	}
	if _, committed, err := queue.CommitBatch(ctx, job, ids[len(ids)-1], true, nil); err != nil || !committed {
		t.Fatalf("complete tied first job: committed=%v err=%v", committed, err)
	}
	job, ids, err = queue.NextBatch(ctx, ChannelMessageNotificationBatchSize)
	if err != nil || job == nil || job.MessageID != wantSecond || len(ids) != 2 {
		t.Fatalf("second tied job did not progress: %#v, %v", job, err)
	}
	if _, committed, err := queue.CommitBatch(ctx, job, ids[len(ids)-1], true, nil); err != nil || !committed {
		t.Fatalf("complete tied second job: committed=%v err=%v", committed, err)
	}
	if job, ids, err = queue.NextBatch(ctx, ChannelMessageNotificationBatchSize); err != nil || job != nil || len(ids) != 0 {
		t.Fatalf("equal timestamp work remained after both completions: %#v %#v %v", job, ids, err)
	}
}
