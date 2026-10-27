package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestPurgeExpiredNotificationsPostgres(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set HICHAT_TEST_POSTGRES_DSN to run the disposable PostgreSQL retention test")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("parse local PostgreSQL test DSN")
	}
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("retention integration test only accepts a loopback PostgreSQL host")
	}
	admin := stdlib.OpenDB(*cfg)
	defer admin.Close()
	schema := fmt.Sprintf("hichat_retention_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal("create isolated PostgreSQL test schema")
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	cfg.RuntimeParams["search_path"] = schema
	db := database.PostgreSQLPool(cfg)
	defer db.Close()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE notifications (
		id TEXT PRIMARY KEY,
		created_at TIMESTAMPTZ NOT NULL
	)`); err != nil {
		t.Fatal("create isolated notifications table")
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE channel_message_notification_jobs (
		message_id TEXT PRIMARY KEY,
		created_at TIMESTAMPTZ NOT NULL
	)`); err != nil {
		t.Fatal("create isolated channel notification jobs table")
	}
	cutoff := time.Now().UTC().Add(-90 * 24 * time.Hour)
	for _, row := range []struct {
		id        string
		createdAt time.Time
	}{
		{id: "expired", createdAt: cutoff.Add(-time.Second)},
		{id: "recent", createdAt: cutoff.Add(time.Second)},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO notifications(id,created_at) VALUES(?,?)`, row.id, row.createdAt); err != nil {
			t.Fatalf("seed %s notification: %v", row.id, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO channel_message_notification_jobs(message_id,created_at) VALUES(?,?)`, row.id, row.createdAt); err != nil {
			t.Fatalf("seed %s channel notification job: %v", row.id, err)
		}
	}

	purgeExpiredNotifications(&database.DB{Conn: db})

	for _, want := range []struct {
		id    string
		count int
	}{{id: "expired", count: 0}, {id: "recent", count: 1}} {
		var got int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notifications WHERE id=?`, want.id).Scan(&got); err != nil {
			t.Fatalf("count %s notification: %v", want.id, err)
		}
		if got != want.count {
			t.Errorf("%s notification count = %d, want %d", want.id, got, want.count)
		}
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM channel_message_notification_jobs WHERE message_id=?`, want.id).Scan(&got); err != nil {
			t.Fatalf("count %s channel notification job: %v", want.id, err)
		}
		if got != want.count {
			t.Errorf("%s channel notification job count = %d, want %d", want.id, got, want.count)
		}
	}
}
