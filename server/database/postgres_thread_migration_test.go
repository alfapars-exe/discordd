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

func TestPostgresThreadTypeMigrationPreservesData(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("test database must be local")
	}
	admin := stdlib.OpenDB(*cfg)
	defer admin.Close()
	schema := fmt.Sprintf("hichat_threads_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
	cfg.RuntimeParams["search_path"] = schema + ",public"
	db := PostgreSQLPool(cfg)
	defer db.Close()
	ctx := context.Background()
	if err := MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}
	// Reproduce an existing installation immediately before native migration
	// 046, without re-running its independently tracked prior migrations.
	for _, query := range []string{
		`ALTER TABLE channels DROP CONSTRAINT channels_type_check`,
		`ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK(type IN ('text','voice','audit'))`,
		`DELETE FROM postgres_schema_migrations WHERE filename='046_thread_channel_type.sql'`,
		`INSERT INTO users(id,username,password_hash) VALUES('u','thread-legacy','test')`,
		`INSERT INTO servers(id,name,owner_id) VALUES('s','legacy','u')`,
		`INSERT INTO channels(id,name,type,server_id,topic) VALUES('c','parent','text','s','preserved')`,
		`INSERT INTO messages(id,channel_id,user_id,content) VALUES('m','c','u','preserved')`,
		`INSERT INTO attachments(id,message_id,filename,file_url) VALUES('a','m','proof','/proof')`,
	} {
		if _, err := db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO channels(id,name,type,server_id) VALUES('rejected','topic','thread','s')`); err == nil {
		t.Fatal("legacy constraint unexpectedly accepted thread")
	}
	if err := MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO channels(id,name,type,server_id,parent_channel_id,starter_message_id) VALUES('thread','topic','thread','s','c','m')`); err != nil {
		t.Fatal(err)
	}
	var content, attachment, parent string
	if err := db.QueryRowContext(ctx, `SELECT m.content,a.file_url,t.parent_channel_id FROM messages m JOIN attachments a ON a.message_id=m.id JOIN channels t ON t.starter_message_id=m.id WHERE t.id='thread'`).Scan(&content, &attachment, &parent); err != nil || content != "preserved" || attachment != "/proof" || parent != "c" {
		t.Fatalf("data changed: %q %q %q %v", content, attachment, parent, err)
	}
	if err := MigratePostgres(ctx, db); err != nil {
		t.Fatalf("repeat startup: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO channels(id,name,type,server_id) VALUES('invalid','topic','invalid','s')`); err == nil {
		t.Fatal("constraint accepted invalid type")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM channels WHERE id='c'`); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM channels WHERE id IN ('c','thread')`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("FK cascade changed: %d %v", remaining, err)
	}
}
