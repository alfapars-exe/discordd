package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"sync"
	"testing"
	"time"
)

type durableVoiceUsageRecorder interface {
	RecordVoiceUsage(context.Context, string, string, int, int, int) error
}

func TestVoiceUsagePostgresReplayTransaction(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('usage-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	recorder, ok := repo.(durableVoiceUsageRecorder)
	if !ok {
		t.Fatal("repository has no durable replay-safe usage contract")
	}
	var wg sync.WaitGroup
	failures := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			failures <- recorder.RecordVoiceUsage(ctx, "session-one", "usage-instance", 2026, 1, 60)
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	used, err := repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 60 {
		t.Fatalf("usage=%d error=%v, want60", used, err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-one", "usage-instance", 2026, 1, 61); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed replay=%v, want conflict", err)
	}
	if _, err = db.ExecContext(ctx, `CREATE FUNCTION reject_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'usage fixture failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TRIGGER reject_usage_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_usage_fixture()`); err != nil {
		t.Fatal(err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-two", "usage-instance", 2026, 1, 30); err == nil {
		t.Fatal("aggregate failure was accepted")
	}
	var rows int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM voice_usage_credits WHERE credit_id='session-two'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("partial ledger persisted: rows=%d err=%v", rows, err)
	}
	if _, err = db.ExecContext(ctx, `DROP TRIGGER reject_usage_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	if err = recorder.RecordVoiceUsage(ctx, "session-two", "usage-instance", 2026, 1, 30); err != nil {
		t.Fatal(err)
	}
	used, err = repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 90 {
		t.Fatalf("usage after retry=%d err=%v, want90", used, err)
	}
}
