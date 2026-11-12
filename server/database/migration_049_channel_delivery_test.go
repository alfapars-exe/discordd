package database

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestChannelDeliveryMigrationPreservesPopulatedDatabase(t *testing.T) {
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
	schema := fmt.Sprintf("hichat_upgrade_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = schema + ",public"
	db := PostgreSQLPool(cfg)
	defer func() { db.Close(); admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() }()
	ctx := context.Background()
	entries, err := postgresMigrations.ReadDir("postgres_migrations")
	if err != nil {
		t.Fatal(err)
	}
	upgrade := slices.IndexFunc(entries, func(entry fs.DirEntry) bool {
		return strings.HasPrefix(entry.Name(), "049_")
	})
	if upgrade < 1 {
		t.Fatal("missing migration 049 or its predecessors")
	}
	if err := applyPostgresMigrations(ctx, db, entries[:upgrade]); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO users(id,username,password_hash) VALUES('u','user','x'),('r','reader','x')`, `INSERT INTO servers(id,name,owner_id) VALUES('s','Server','u')`, `INSERT INTO channels(id,name,type,server_id) VALUES('c','Channel','text','s')`, `INSERT INTO messages(id,channel_id,user_id,content,created_at) VALUES('z','c','u','second','2026-01-01'),('a','c','u','first','2026-01-01')`, `INSERT INTO channel_reads(user_id,channel_id,last_read_message_id,unread_count) VALUES('r','c','a',1)`, `INSERT INTO attachments(id,message_id,filename,file_url) VALUES('file','z','file','/api/uploads/file')`, `INSERT INTO message_mentions(message_id,user_id) VALUES('z','r')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err = MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}
	var first, second, read, last int64
	if err = db.QueryRow(`SELECT (SELECT source_sequence FROM messages WHERE id='a'),(SELECT source_sequence FROM messages WHERE id='z'),(SELECT last_read_source_sequence FROM channel_reads WHERE user_id='r'),(SELECT last_source_sequence FROM channels WHERE id='c')`).Scan(&first, &second, &read, &last); err != nil {
		t.Fatal(err)
	}
	if first != 1 || second != 2 || read != 1 || last != 2 {
		t.Fatalf("watermarks %d %d %d %d", first, second, read, last)
	}
	for table, want := range map[string]int{"messages": 2, "attachments": 1, "message_mentions": 1, "channel_delivery_outbox": 0} {
		var n int
		if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil || n != want {
			t.Fatalf("%s: %d %v", table, n, err)
		}
	}
	if err = MigratePostgres(ctx, db); err != nil {
		t.Fatal("migration replay", err)
	}
}
