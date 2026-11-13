package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"io/fs"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestPostgresVoiceUsageMigrationPreservesTotals(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid local fixture config")
	}
	if cfg.Host != "127.0.0.1" && cfg.Host != "localhost" {
		t.Fatal("requires local fixture")
	}
	var identity [12]byte
	if _, err = rand.Read(identity[:]); err != nil {
		t.Fatal(err)
	}
	schema := "hichat_usage_upgrade_" + hex.EncodeToString(identity[:])
	quoted := pgx.Identifier{schema}.Sanitize()
	admin := stdlib.OpenDB(*cfg)
	create := fmt.Sprintf("CREATE SCHEMA %s", quoted)
	drop := fmt.Sprintf("DROP SCHEMA %s CASCADE", quoted)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err = admin.ExecContext(ctx, create); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	cfg.RuntimeParams["search_path"] = schema + ",public"
	db := PostgreSQLPool(cfg)
	defer func() {
		db.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanup, drop); err != nil {
			t.Error("owned upgrade schema cleanup failed")
		}
		admin.Close()
	}()
	entries, err := postgresMigrations.ReadDir("postgres_migrations")
	if err != nil {
		t.Fatal(err)
	}
	index := slices.IndexFunc(entries, func(entry fs.DirEntry) bool { return strings.HasPrefix(entry.Name(), "054_") })
	if index < 1 {
		t.Fatal("native usage migration054 missing")
	}
	if err = applyPostgresMigrations(ctx, db, entries[:index]); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('legacy','http://127.0.0.1','fixture','fixture')`,
		`INSERT INTO livekit_monthly_usage(instance_id,year,month,used_seconds) VALUES('legacy',2026,1,120)`,
	} {
		if _, err = db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := postgresMigrations.ReadFile("postgres_migrations/" + entries[index].Name())
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, string(migration)); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, "SELECT 1/0"); err == nil {
		tx.Rollback()
		t.Fatal("failure injection did not fail")
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err = db.QueryRowContext(ctx, "SELECT to_regclass($1) IS NOT NULL", schema+".voice_usage_credits").Scan(&exists); err != nil || exists {
		t.Fatalf("failed migration retained ledger: exists=%v err=%v", exists, err)
	}
	if err = applyPostgresMigrations(ctx, db, entries[:index+1]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO voice_usage_credits(credit_id,instance_id,year,month,seconds) VALUES('preserved','legacy',2026,1,120)`); err != nil {
		t.Fatal(err)
	}
	if err = MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err = MigratePostgres(ctx, db); err != nil {
		t.Fatal(err)
	}
	var used, credits, journal int
	var applied bool
	if err = db.QueryRowContext(ctx, `SELECT (SELECT used_seconds FROM livekit_monthly_usage WHERE instance_id='legacy' AND year=2026 AND month=1),(SELECT count(*) FROM voice_usage_credits WHERE credit_id='preserved'),(SELECT count(*) FROM postgres_schema_migrations WHERE filename='054_voice_usage_credits.sql'),(SELECT applied_at IS NOT NULL FROM voice_usage_credits WHERE credit_id='preserved')`).Scan(&used, &credits, &journal, &applied); err != nil {
		t.Fatal(err)
	}
	if used != 120 || credits != 1 || journal != 1 || !applied {
		t.Fatalf("upgrade/restart changed data: total=%d credits=%d journal=%d", used, credits, journal)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO voice_usage_credits(credit_id,instance_id,year,month,seconds) VALUES('invalid','legacy',2026,13,1)`); err == nil {
		t.Fatal("ledger accepted invalid month")
	}
}
