package main

import (
	"context"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/jackc/pgx/v5"
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
func TestChannelMessagingPostgresCompositionSelectsDurablePublication(t *testing.T) {
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
	db := database.PostgreSQLPool(parsed)
	t.Cleanup(func() { db.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.MigratePostgres(ctx, db); err != nil {
		t.Fatal("migrate PostgreSQL fixture")
	}
	repos := initRepositories(db, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	hub := &messagingModeHub{Hub: ws.NewHub()}
	group := initChannelMessagingServices(db, repos, hub, &config.Config{}, &testutil.MockChannelPermResolver{}, nil)
	if group.DeliveryDB != db || group.Message == nil || group.Upload == nil || group.Notifications == nil || hub.calls != 1 || !hub.enabled {
		t.Fatalf("durable composition mode calls=%d enabled=%v", hub.calls, hub.enabled)
	}
}
