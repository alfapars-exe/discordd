package services

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"os"
	"sync"
	"testing"
	"time"
)

func newDMSendTestDB(t *testing.T) *database.DB {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		return newBotTestDB(t)
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("DM receipt fixture requires local PostgreSQL")
	}
	admin := stdlib.OpenDB(*cfg)
	schema := fmt.Sprintf("hichat_dm_send_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = schema + ",public"
	pool := database.PostgreSQLPool(cfg)
	t.Cleanup(func() { pool.Close(); _, _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() })
	if err := database.MigratePostgres(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	return &database.DB{Conn: pool}
}

func TestDMIdempotentSendConcurrentReplayConflictAndDeletion(t *testing.T) {
	db := newDMSendTestDB(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob", "carol"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	block := &testutil.MockBlockChecker{}
	svc := NewDMService(repo, repository.NewSQLiteUserRepo(db.Conn), &testutil.MockBroadcaster{}, block, nil, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	const key = "send-request-0000001"
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "one message", ClientMessageID: key})
			if err != nil {
				errs <- err
				return
			}
			ids <- m.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	original := ""
	for id := range ids {
		if original != "" && original != id {
			t.Fatal("retry created another message")
		}
		original = id
	}
	if original == "" {
		t.Fatal("no committed message")
	}
	var count, unread int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id=?`, ch.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT unread_count FROM dm_reads WHERE dm_channel_id=? AND user_id='bob'`, ch.ID).Scan(&unread); err != nil {
		t.Fatal(err)
	}
	if count != 1 || unread != 1 {
		t.Fatalf("messages=%d unread=%d", count, unread)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications WHERE dm_channel_id=?`, ch.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("duplicate notifications=%d", count)
	}
	_, err := svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "different", ClientMessageID: key})
	if !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("conflicting retry: %v", err)
	}
	_, err = svc.SendMessage(ctx, "carol", ch.ID, &models.CreateDMMessageRequest{Content: "one message", ClientMessageID: key})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("nonmember retry: %v", err)
	}
	block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return true, nil }
	_, err = svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "one message", ClientMessageID: key})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("blocked retry: %v", err)
	}
	block.IsBlockedFn = nil
	if _, err := db.Conn.Exec(`DELETE FROM dm_messages WHERE id=?`, original); err != nil {
		t.Fatal(err)
	}
	_, err = svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "one message", ClientMessageID: key})
	if !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("deleted message replay: %v", err)
	}
}

func TestDMIdempotentSendRollsBackReceiptAndUnread(t *testing.T) {
	db := newDMSendTestDB(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	triggerSQL := `CREATE TRIGGER reject_dm_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`
	if database.IsPostgres(db.Conn) {
		triggerSQL = `CREATE FUNCTION reject_dm_notification_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER reject_dm_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_dm_notification_fn()`
	}
	if _, err := db.Conn.Exec(triggerSQL); err != nil {
		t.Fatal(err)
	}
	svc := NewDMService(repo, repository.NewSQLiteUserRepo(db.Conn), &testutil.MockBroadcaster{}, nil, nil, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	req := &models.CreateDMMessageRequest{Content: "retry after rollback", ClientMessageID: "send-request-0000002"}
	if _, err := svc.SendMessage(ctx, "alice", ch.ID, req); err == nil {
		t.Fatal("expected failed notification transaction")
	}
	for _, table := range []string{"dm_messages", "dm_send_receipts", "dm_reads"} {
		var n int
		if err := db.Conn.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s committed after rollback", table)
		}
	}
	dropTrigger := `DROP TRIGGER reject_dm_notification`
	if database.IsPostgres(db.Conn) {
		dropTrigger += ` ON notifications`
	}
	if _, err := db.Conn.Exec(dropTrigger); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SendMessage(ctx, "alice", ch.ID, req); err != nil {
		t.Fatal(err)
	}
}
