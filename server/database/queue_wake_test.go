package database

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestQueueWakerCoalescesAndIsNilSafe(t *testing.T) {
	var none *QueueWaker
	if none.Subscribe(WakeDMDelivery) != nil {
		t.Fatal("nil waker must return a nil (never firing) channel")
	}
	none.Wake(WakeDMDelivery)

	w := NewQueueWaker()
	dm := w.Subscribe(WakeDMDelivery)
	channel := w.Subscribe(WakeChannelDelivery)
	w.Wake(WakeDMDelivery)
	w.Wake(WakeDMDelivery) // coalesced, must not block
	select {
	case <-dm:
	default:
		t.Fatal("subscriber was not woken")
	}
	select {
	case <-dm:
		t.Fatal("wakes were not coalesced")
	case <-channel:
		t.Fatal("wake leaked to another table")
	default:
	}
	w.wakeAll()
	for _, ch := range []<-chan struct{}{dm, channel} {
		select {
		case <-ch:
		default:
			t.Fatal("wakeAll missed a subscriber")
		}
	}
}

// The migration trigger must reach a LISTEN connection on commit.
func TestQueueWakeListenerReceivesQueueInsert(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "localhost" && cfg.Host != "127.0.0.1" {
		t.Fatal("local database required")
	}
	admin := stdlib.OpenDB(*cfg)
	defer admin.Close()
	schema := fmt.Sprintf("hichat_queue_wake_%d", time.Now().UnixNano())
	quoted := pgx.Identifier{schema}.Sanitize()
	createSchema, dropSchema := "CREATE SCHEMA "+quoted, "DROP SCHEMA "+quoted+" CASCADE"
	if _, err = admin.Exec(createSchema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(dropSchema); err != nil {
			t.Errorf("drop fixture schema: %v", err)
		}
	}()
	cfg.RuntimeParams["search_path"] = schema + ",public"
	db := PostgreSQLPool(cfg)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err = MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}

	w := NewQueueWaker()
	wake := w.Subscribe(WakeChannelNotifications)
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(runCtx, func(c context.Context) (*pgx.Conn, error) { return pgx.ConnectConfig(c, cfg.Copy()) }, nil)
	}()
	defer func() { stop(); <-done }()

	select { // the post-LISTEN catch-up wake proves the listener is subscribed
	case <-wake:
	case <-time.After(10 * time.Second):
		t.Fatal("listener never connected")
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO channel_message_notification_jobs(message_id,server_id,channel_id,actor_id) VALUES('m-wake','s','c','a')`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-wake:
	case <-time.After(10 * time.Second):
		t.Fatal("queue insert did not wake the listener")
	}
}
