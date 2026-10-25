package database

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestPostgresImportPreservesDataAndRejectsReuse(t *testing.T) {
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
	schema := fmt.Sprintf("hichat_import_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
	cfg.RuntimeParams["search_path"] = schema + ",public"
	target := PostgreSQLPool(cfg)
	defer target.Close()
	ctx := context.Background()
	if err = MigratePostgres(ctx, target); err != nil {
		t.Fatal(err)
	}
	migrations, _ := fs.Sub(EmbeddedMigrations, "migrations")
	source, err := New(filepath.Join(t.TempDir(), "snapshot.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	for _, q := range []string{
		`INSERT INTO users(id,username,password_hash) VALUES('import-user','import-user','opaque-password-hash')`,
		`INSERT INTO servers(id,name,owner_id) VALUES('import-server','Server','import-user')`,
		`INSERT INTO channels(id,name,type,server_id) VALUES('import-channel','general','text','import-server')`,
		`INSERT INTO messages(id,channel_id,user_id,content,encryption_version) VALUES('import-message','import-channel','import-user','opaque-ciphertext',1)`,
		`INSERT INTO attachments(id,message_id,filename,file_url) VALUES('import-file','import-message','f.bin','/api/uploads/preserved.bin')`,
		`INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('test-instance','https://example.invalid','test-only','test-only')`,
		`INSERT INTO livekit_metrics_history(id,instance_id) VALUES(42,'test-instance')`,
	} {
		if _, err = source.Conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	// A historical orphan must abort the entire import, not silently drop
	// the relationship or leave a partially populated target behind.
	source.Conn.SetMaxOpenConns(1)
	if _, err = source.Conn.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatal(err)
	}
	if _, err = source.Conn.Exec(`INSERT INTO attachments(id,message_id,filename,file_url) VALUES('orphan','missing-message','orphan.bin','/api/uploads/orphan.bin')`); err != nil {
		t.Fatal(err)
	}
	if _, err = ImportSQLiteSnapshot(ctx, source.Conn, target); err == nil {
		t.Fatal("orphan relationship accepted")
	}
	var remaining int
	if err = target.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("partial import persisted: %d %v", remaining, err)
	}
	if _, err = source.Conn.Exec(`DELETE FROM attachments WHERE id='orphan'`); err != nil {
		t.Fatal(err)
	}
	if _, err = source.Conn.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		t.Fatal(err)
	}
	report, err := ImportSQLiteSnapshot(ctx, source.Conn, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(report) != 76 {
		t.Fatalf("unexpected table count %d", len(report))
	}
	var hash, ciphertext, url string
	if err = target.QueryRow(`SELECT u.password_hash,m.content,a.file_url FROM users u JOIN messages m ON m.user_id=u.id JOIN attachments a ON a.message_id=m.id WHERE m.id='import-message'`).Scan(&hash, &ciphertext, &url); err != nil {
		t.Fatal(err)
	}
	if hash != "opaque-password-hash" || ciphertext != "opaque-ciphertext" || url != "/api/uploads/preserved.bin" {
		t.Fatal("opaque fields changed")
	}
	var nextID int64
	if err = target.QueryRow(`INSERT INTO livekit_metrics_history(instance_id) VALUES('test-instance') RETURNING id`).Scan(&nextID); err != nil || nextID <= 42 {
		t.Fatalf("identity sequence not advanced: %d %v", nextID, err)
	}
	if _, err = ImportSQLiteSnapshot(ctx, source.Conn, target); err == nil {
		t.Fatal("existing target reused")
	}
}
