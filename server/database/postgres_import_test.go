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
	if _, err = target.Exec(`UPDATE data_export_archive_budget SET reserved_bytes=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err = ImportSQLiteSnapshot(ctx, source.Conn, target); err == nil {
		t.Fatal("non-default archive budget seed accepted")
	}
	if _, err = target.Exec(`UPDATE data_export_archive_budget SET reserved_bytes=0 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	legacySource, err := New(filepath.Join(t.TempDir(), "legacy-snapshot.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = legacySource.Conn.Exec(`DROP TABLE data_export_archive_budget`); err != nil {
		legacySource.Close()
		t.Fatal(err)
	}
	if _, err = ImportSQLiteSnapshot(ctx, legacySource.Conn, target); err == nil {
		legacySource.Close()
		t.Fatal("source missing archive budget table accepted")
	}
	if err = legacySource.Close(); err != nil {
		t.Fatal(err)
	}
	var seededBudgetRows, seededBudgetBytes int
	if err = target.QueryRow(`SELECT COUNT(*),COALESCE(MAX(reserved_bytes),-1) FROM data_export_archive_budget`).Scan(&seededBudgetRows, &seededBudgetBytes); err != nil {
		t.Fatal(err)
	}
	if seededBudgetRows != 1 || seededBudgetBytes != 0 {
		t.Fatalf("legacy import did not preserve migration seed after rollback: rows=%d bytes=%d", seededBudgetRows, seededBudgetBytes)
	}
	for _, q := range []string{
		`INSERT INTO users(id,username,password_hash) VALUES('import-user','import-user','opaque-password-hash')`,
		`INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('import-dm','import-user','import-user')`,
		`INSERT INTO dm_messages(id,dm_channel_id,user_id,content,source_sequence) VALUES('z-import-earlier','import-dm','import-user','opaque-DM',200),('a-import-later','import-dm','import-user','opaque-DM-later',500)`,
		`INSERT INTO dm_reads(user_id,dm_channel_id,last_read_message_id,last_read_source_sequence,last_read_at,unread_count) VALUES('import-user','import-dm','z-import-earlier',200,'2026-01-01',1)`,
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
	// Assert coverage against the actual source schema, not an obsolete count
	// that stops the acceptance test whenever an additive migration is added.
	expectedRows, err := source.Conn.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'dm_messages_fts%'`)
	if err != nil {
		t.Fatal(err)
	}
	expectedTables := map[string]bool{}
	for expectedRows.Next() {
		var name string
		if err = expectedRows.Scan(&name); err != nil {
			expectedRows.Close()
			t.Fatal(err)
		}
		expectedTables[name] = true
	}
	if err = expectedRows.Err(); err != nil {
		expectedRows.Close()
		t.Fatal(err)
	}
	if err = expectedRows.Close(); err != nil {
		t.Fatal(err)
	}
	if len(report) != len(expectedTables) || !expectedTables["group_dm_pins"] || !expectedTables["users"] {
		t.Fatalf("incomplete schema report: got %d tables, expected %d", len(report), len(expectedTables))
	}
	var foundArchiveBudget bool
	for _, table := range report {
		if !expectedTables[table.Table] || len(table.SHA256) != 64 {
			t.Fatalf("unexpected, duplicate or unhashed table in import report: %s", table.Table)
		}
		if table.Table == "data_export_archive_budget" {
			foundArchiveBudget = table.Rows == 1
		}
		delete(expectedTables, table.Table)
	}
	if !foundArchiveBudget {
		t.Fatal("archive budget source row was not included in import report")
	}
	if err = target.QueryRow(`SELECT COUNT(*),COALESCE(MAX(reserved_bytes),-1) FROM data_export_archive_budget`).Scan(&seededBudgetRows, &seededBudgetBytes); err != nil {
		t.Fatal(err)
	}
	if seededBudgetRows != 1 || seededBudgetBytes != 0 {
		t.Fatalf("archive budget source row was not preserved: rows=%d bytes=%d", seededBudgetRows, seededBudgetBytes)
	}
	var hash, ciphertext, url string
	if err = target.QueryRow(`SELECT u.password_hash,m.content,a.file_url FROM users u JOIN messages m ON m.user_id=u.id JOIN attachments a ON a.message_id=m.id WHERE m.id='import-message'`).Scan(&hash, &ciphertext, &url); err != nil {
		t.Fatal(err)
	}
	if hash != "opaque-password-hash" || ciphertext != "opaque-ciphertext" || url != "/api/uploads/preserved.bin" {
		t.Fatal("opaque fields changed")
	}
	var importedSequence, importedCounter, readSequence int64
	if err = target.QueryRow(`SELECT source_sequence FROM dm_messages WHERE id='a-import-later'`).Scan(&importedSequence); err != nil || importedSequence != 500 {
		t.Fatalf("DM source sequence changed: %d %v", importedSequence, err)
	}
	if err = target.QueryRow(`SELECT last_source_sequence FROM dm_channels WHERE id='import-dm'`).Scan(&importedCounter); err != nil || importedCounter != 500 {
		t.Fatalf("DM counter changed on out-of-order import: %d %v", importedCounter, err)
	}
	if err = target.QueryRow(`SELECT last_read_source_sequence FROM dm_reads WHERE dm_channel_id='import-dm'`).Scan(&readSequence); err != nil || readSequence != 200 {
		t.Fatalf("read watermark changed on import: %d %v", readSequence, err)
	}
	if _, err = target.Exec(`INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('import-next','import-dm','import-user','opaque-next')`); err != nil {
		t.Fatal(err)
	}
	if err = target.QueryRow(`SELECT source_sequence FROM dm_messages WHERE id='import-next'`).Scan(&importedSequence); err != nil || importedSequence != 501 {
		t.Fatalf("post-import allocation failed: %d %v", importedSequence, err)
	}
	var nextID int64
	if err = target.QueryRow(`INSERT INTO livekit_metrics_history(instance_id) VALUES('test-instance') RETURNING id`).Scan(&nextID); err != nil || nextID <= 42 {
		t.Fatalf("identity sequence not advanced: %d %v", nextID, err)
	}
	if _, err = ImportSQLiteSnapshot(ctx, source.Conn, target); err == nil {
		t.Fatal("existing target reused")
	}
}
