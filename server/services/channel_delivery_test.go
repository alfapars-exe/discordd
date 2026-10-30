package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func channelDeliveryFixture(t *testing.T) (*messageService, *sql.DB, *testutil.MockBroadcastAndOnline, *testutil.MockChannelPermResolver) {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("local database required")
	}
	admin := stdlib.OpenDB(*cfg)
	schema := fmt.Sprintf("hichat_delivery_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = schema + ",public"
	db := database.PostgreSQLPool(cfg)
	db.SetMaxOpenConns(8)
	t.Cleanup(func() { db.Close(); admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() })
	if err = database.MigratePostgres(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO users(id,username,password_hash) VALUES('sender','sender','x'),('reader','reader','x')`, `INSERT INTO servers(id,name,owner_id) VALUES('default','Default','sender')`, `INSERT INTO channels(id,name,type,server_id) VALUES('channel','general','text','default')`, `INSERT INTO server_members(server_id,user_id) VALUES('default','sender'),('default','reader')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	perms := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
		return models.PermViewChannel | models.PermSendMessages | models.PermReadMessages, nil
	}, ResolveChannelPermissionsBulkFn: func(_ context.Context, _ string, users []string) (map[string]models.Permission, error) {
		m := map[string]models.Permission{}
		for _, u := range users {
			m[u] = models.PermViewChannel | models.PermReadMessages
		}
		return m, nil
	}}
	hub := &testutil.MockBroadcastAndOnline{GetOnlineUserIDsForServerFn: func(string) []string { return []string{"sender", "reader"} }}
	service := NewMessageService(repository.NewSQLiteMessageRepo(db), repository.NewSQLiteAttachmentRepo(db), repository.NewSQLiteChannelRepo(db), repository.NewSQLiteUserRepo(db), repository.NewSQLiteMentionRepo(db), repository.NewSQLiteRoleMentionRepo(db), repository.NewSQLiteRoleRepo(db), repository.NewSQLiteReactionRepo(db), repository.NewPostgresReadStateRepo(db), nil, repository.NewMessageTxRunner(db), hub, perms, nil, repository.NewSQLiteNotificationRepo(db))
	ConfigureChannelDelivery(service, db)
	return service.(*messageService), db, hub, perms
}

func TestChannelDeliveryConcurrentRetryAndDeletion(t *testing.T) {
	s, db, _, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "hello <@reader>", ClientMessageID: "same-send"})
			if err != nil {
				errs <- err
			} else {
				ids <- m.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	id := ""
	for current := range ids {
		if id != "" && current != id {
			t.Fatal("duplicate messages")
		}
		id = current
	}
	for table, want := range map[string]int{"messages": 1, "message_mentions": 1, "notifications": 1, "channel_delivery_outbox": 2} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != want {
			t.Fatalf("%s count=%d want=%d err=%v", table, count, want, err)
		}
	}
	if _, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "changed", ClientMessageID: "same-send"}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed retry: %v", err)
	}
	if err := s.Delete(ctx, "default", id, "sender", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "hello <@reader>", ClientMessageID: "same-send"}); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("deleted retry: %v", err)
	}
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&count)
	if count != 0 {
		t.Fatal("deleted retry recreated a message")
	}
}

func TestChannelDeliveryCrashRetryReplayAndPermissions(t *testing.T) {
	s, db, hub, perms := channelDeliveryFixture(t)
	ctx := context.Background()
	m, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "one", ClientMessageID: "first"})
	if err != nil {
		t.Fatal(err)
	}
	var sent []ws.Event
	hub.BroadcastToUsersFn = func(_ []string, e ws.Event) { sent = append(sent, e) }
	// No handler broadcast occurred. A worker created after commit can publish.
	if !s.deliverNext(ctx) || len(sent) != 1 {
		t.Fatal("committed event lost")
	}
	first := sent[0]
	// Crash after enqueue, before published_at acknowledgement: replay identity is stable.
	db.Exec(`UPDATE channel_delivery_outbox SET published_at=NULL,lease_until=NULL`)
	if !s.deliverNext(ctx) || len(sent) != 2 || sent[1].EventID != first.EventID {
		t.Fatal("retry identity changed")
	}
	if _, err = s.Update(ctx, "default", m.ID, "sender", &models.UpdateMessageRequest{Content: "two"}); err != nil {
		t.Fatal(err)
	}
	page, err := s.ChannelEvents(ctx, "default", "channel", "reader", 1)
	if err != nil || len(page.Events) != 1 || page.Events[0].Op != ws.OpMessageUpdate {
		t.Fatalf("edit replay: %+v %v", page, err)
	}
	var updated models.Message
	if err = json.Unmarshal(page.Events[0].Data, &updated); err != nil || updated.Content == nil || *updated.Content != "two" {
		t.Fatal("edit payload")
	}
	perms.ResolveChannelPermissionsBulkFn = func(context.Context, string, []string) (map[string]models.Permission, error) {
		return nil, fmt.Errorf("temporary failure")
	}
	s.deliverNext(ctx)
	var published sql.NullTime
	var attempts int
	db.QueryRow(`SELECT published_at,attempts FROM channel_delivery_outbox WHERE op='message_update'`).Scan(&published, &attempts)
	if published.Valid || attempts != 1 {
		t.Fatal("failed publish was acknowledged")
	}
	perms.ResolveChannelPermissionsFn = func(context.Context, string, string) (models.Permission, error) { return 0, nil }
	if _, err = s.ChannelEvents(ctx, "default", "channel", "reader", 1); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatal("replay leaked after revocation")
	}
	perms.ResolveChannelPermissionsFn = func(context.Context, string, string) (models.Permission, error) {
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	db.Exec(`UPDATE channel_delivery_outbox SET created_at=CURRENT_TIMESTAMP-INTERVAL '8 days'`)
	page, err = s.ChannelEvents(ctx, "default", "channel", "reader", 1)
	if err != nil || !page.Reset {
		t.Fatal("expired cursor did not reset")
	}
}

func TestChannelDeliveryAttachmentRecoveryAndWatermark(t *testing.T) {
	s, db, _, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	m, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "files", HasFiles: true, FileNames: []string{"one", "two"}, ClientMessageID: "files"})
	if err != nil {
		t.Fatal(err)
	}
	if s.deliverNext(ctx) {
		t.Fatal("unprepared attachments published")
	}
	index := 0
	a := &models.Attachment{MessageID: m.ID, Filename: "one", FileURL: "/api/uploads/one", PreparationIndex: &index}
	if err = s.attachmentRepo.Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	db.Exec(`UPDATE channel_attachment_jobs SET updated_at=CURRENT_TIMESTAMP-INTERVAL '31 minutes' WHERE status='preparing'`)
	db.Exec(`UPDATE channel_delivery_outbox SET created_at=CURRENT_TIMESTAMP-INTERVAL '31 minutes'`)
	s.deliveryTick(ctx)
	if err = s.loadAttachmentStates(ctx, m); err != nil {
		t.Fatal(err)
	}
	if len(m.AttachmentStates) != 2 || m.AttachmentStates[0].Status != "ready" || m.AttachmentStates[1].Status != "failed" {
		t.Fatalf("states: %+v", m.AttachmentStates)
	}
	reads := repository.NewPostgresReadStateRepo(db)
	if err = reads.Upsert(ctx, "reader", "channel", m.ID); err != nil {
		t.Fatal(err)
	}
	n, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "next"})
	if err != nil {
		t.Fatal(err)
	}
	counts, err := reads.GetUnreadCounts(ctx, "reader", "default")
	if err != nil || len(counts) != 1 || counts[0].UnreadCount != 1 {
		t.Fatalf("unreads: %+v %v", counts, err)
	}
	if err = s.Delete(ctx, "default", m.ID, "sender", 0); err != nil {
		t.Fatal(err)
	}
	counts, err = reads.GetUnreadCounts(ctx, "reader", "default")
	if err != nil || len(counts) != 1 || counts[0].UnreadCount != 1 {
		t.Fatal("anchor deletion broke watermark")
	}
	if _, err = reads.MarkUnreadFrom(ctx, "reader", "channel", n.ID); err != nil {
		t.Fatal(err)
	}
}

func TestChannelDeliveryMessageProgressPastDeferredNotification(t *testing.T) {
	s, db, hub, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "first <@reader>"}); err != nil {
		t.Fatal(err)
	}
	if !s.deliverNext(ctx) {
		t.Fatal("first message not published")
	}
	if _, err := db.Exec(`UPDATE channel_delivery_outbox SET available_at=CURRENT_TIMESTAMP+INTERVAL '1 day' WHERE op='notification_create'`); err != nil {
		t.Fatal(err)
	}
	second, err := s.Create(ctx, "default", "channel", "sender", &models.CreateMessageRequest{Content: "second"})
	if err != nil {
		t.Fatal(err)
	}
	var delivered ws.Event
	hub.BroadcastToUsersFn = func(_ []string, event ws.Event) { delivered = event }
	if !s.deliverNext(ctx) || delivered.Op != ws.OpMessageCreate {
		t.Fatal("notification backlog blocked message publication")
	}
	var message models.Message
	if err = json.Unmarshal(delivered.Data.(json.RawMessage), &message); err != nil || message.ID != second.ID {
		t.Fatal("wrong message published")
	}
}

// Lock every reader row to prove that a send neither writes nor waits on the
// reader population. xmin also detects writes that leave counter values equal.
func TestChannelDeliveryDoesNotWriteReaderRows(t *testing.T) {
	s, db, _, _ := channelDeliveryFixture(t)
	ctx := context.Background()
	for _, query := range []string{
		`INSERT INTO users(id,username,password_hash) SELECT 'scale_reader_'||n,'scale_reader_'||n,'x' FROM generate_series(1,1000) n`,
		`INSERT INTO channel_reads(user_id,channel_id,last_read_source_sequence) SELECT id,'channel',0 FROM users WHERE id LIKE 'scale_reader_%'`,
	} {
		if _, err := db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	var before, after int64
	if err := db.QueryRowContext(ctx, `SELECT SUM(xmin::text::bigint) FROM channel_reads WHERE channel_id='channel'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	locked, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback()
	rows, err := locked.QueryContext(ctx, `SELECT user_id FROM channel_reads WHERE channel_id='channel' FOR UPDATE`)
	if err != nil {
		t.Fatal(err)
	}
	readers := 0
	for rows.Next() {
		readers++
	}
	rowErr := rows.Err()
	rows.Close()
	if rowErr != nil {
		t.Fatal(rowErr)
	}
	if readers != 1000 {
		t.Fatalf("locked readers=%d", readers)
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := s.Create(bounded, "default", "channel", "sender", &models.CreateMessageRequest{Content: "reader-independent send", ClientMessageID: "reader-scale"}); err != nil {
		t.Fatalf("send waited on reader rows: %v", err)
	}
	elapsed := time.Since(started)
	if err := db.QueryRowContext(ctx, `SELECT SUM(xmin::text::bigint) FROM channel_reads WHERE channel_id='channel'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("send rewrote read state")
	}
	t.Logf("readers=%d reader_row_writes=0 send_elapsed=%s", readers, elapsed)
}
