package main

import (
	"context"
	"database/sql"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"os"
	"testing"
	"time"
)

type messagingModeHub struct {
	*ws.Hub
	calls   int
	enabled bool
}

func (h *messagingModeHub) SetDurableChannelSends(enabled bool) {
	h.calls++
	h.enabled = enabled
	h.Hub.SetDurableChannelSends(enabled)
}

// compositionPostgresDB is sequential: each caller owns and drops the fixture
// schema before the next test; public application tables remain untouched.
func compositionPostgresDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires disposable loopback PostgreSQL")
	}
	parsed, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid PostgreSQL fixture configuration")
	}
	if parsed.Host != "127.0.0.1" && parsed.Host != "localhost" {
		t.Fatal("requires disposable loopback PostgreSQL")
	}
	admin := stdlib.OpenDB(*parsed)
	var publicBefore int
	if err := admin.QueryRow("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='user_roles'").Scan(&publicBefore); err != nil {
		admin.Close()
		t.Fatal("read public schema baseline")
	}
	if _, err := admin.Exec("CREATE SCHEMA hichat_messaging_wiring_fixture"); err != nil {
		admin.Close()
		t.Fatal("create isolated messaging fixture schema")
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP SCHEMA hichat_messaging_wiring_fixture CASCADE"); err != nil {
			t.Error("remove messaging fixture schema")
		}
		var publicAfter int
		if err := admin.QueryRow("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='user_roles'").Scan(&publicAfter); err != nil || publicAfter != publicBefore {
			t.Error("messaging fixture changed public application tables")
		}
		if err := admin.Close(); err != nil {
			t.Error("close fixture control pool")
		}
	})
	scoped := parsed.Copy()
	scoped.RuntimeParams["search_path"] = "hichat_messaging_wiring_fixture,public"
	db := database.PostgreSQLPool(scoped)
	t.Cleanup(func() { db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.MigratePostgres(ctx, db); err != nil {
		t.Fatal("migrate PostgreSQL fixture")
	}
	return db
}
func TestChannelMessagingPostgresCompositionSelectsDurablePublication(t *testing.T) {
	db := compositionPostgresDB(t)
	repos := initRepositories(db, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	hub := &messagingModeHub{Hub: ws.NewHub()}
	group := initChannelMessagingServices(db, repos, hub, &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
	if group.DeliveryDB != db || group.Message == nil || group.Upload == nil || group.Notifications == nil || hub.calls != 1 || !hub.enabled {
		t.Fatalf("durable composition mode calls=%d enabled=%v", hub.calls, hub.enabled)
	}
}
