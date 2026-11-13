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
	ended := time.Date(2026, time.January, 31, 23, 59, 59, 0, time.UTC)
	service := &voiceService{livekitGetter: repo}
	service.creditUsageSession("session-three", "usage-instance", true, ended.Add(-time.Minute), ended)
	service.creditUsageSession("session-three", "usage-instance", true, ended.Add(-time.Minute), ended)
	service.creditUsageSession("session-four", "usage-instance", true, ended.Add(-time.Minute), ended)
	used, err = repo.GetMonthlyUsage(ctx, "usage-instance", 2026, 1)
	if err != nil || used != 210 {
		t.Fatalf("service replay/session separation usage=%d err=%v, want210", used, err)
	}

}

type pendingVoiceUsageQueue interface {
	EnqueueVoiceUsage(context.Context, string, string, int, int, int) error
	ApplyNextVoiceUsage(context.Context) (bool, error)
}

func TestVoiceUsagePostgresPendingRecovery(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('pending-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	queue, ok := repo.(pendingVoiceUsageQueue)
	if !ok {
		t.Fatal("repository has no durable pending usage handoff")
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 60); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 60); err != nil {
		t.Fatal(err)
	}
	if err := queue.EnqueueVoiceUsage(ctx, "pending-session", "pending-instance", 2026, 1, 61); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed pending replay=%v", err)
	}
	used, err := repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 0 {
		t.Fatalf("enqueue prematurely changed usage: %d %v", used, err)
	}
	if _, err = db.ExecContext(ctx, `CREATE FUNCTION reject_pending_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pending fixture failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TRIGGER reject_pending_fixture BEFORE INSERT OR UPDATE ON livekit_monthly_usage FOR EACH ROW EXECUTE FUNCTION reject_pending_fixture()`); err != nil {
		t.Fatal(err)
	}
	if applied, err := queue.ApplyNextVoiceUsage(ctx); err == nil || applied {
		t.Fatal("failed aggregate reported applied")
	}
	var pending int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM voice_usage_credits WHERE credit_id='pending-session' AND applied_at IS NULL`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("pending handoff lost: %d %v", pending, err)
	}
	if _, err = db.ExecContext(ctx, `DROP TRIGGER reject_pending_fixture ON livekit_monthly_usage`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `CREATE TRIGGER reject_usage_marker BEFORE UPDATE ON voice_usage_credits FOR EACH ROW EXECUTE FUNCTION reject_pending_fixture()`); err != nil {
		t.Fatal(err)
	}
	if applied, err := queue.ApplyNextVoiceUsage(ctx); err == nil || applied {
		t.Fatal("marker failure reported applied")
	}
	used, err = repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 0 {
		t.Fatalf("failed marker committed aggregate: %d %v", used, err)
	}
	if _, err = db.ExecContext(ctx, `DROP TRIGGER reject_usage_marker ON voice_usage_credits`); err != nil {
		t.Fatal(err)
	}
	// A fresh repository represents restart: no process-local queue is reused.
	recovered := repository.NewSQLiteLiveKitRepo(db).(pendingVoiceUsageQueue)
	type applyResult struct {
		applied bool
		err     error
	}
	results := make(chan applyResult, 16)
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			applied, err := recovered.ApplyNextVoiceUsage(ctx)
			results <- applyResult{applied, err}
		}()
	}
	workers.Wait()
	close(results)
	appliedCount := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.applied {
			appliedCount++
		}
	}
	if appliedCount != 1 {
		t.Fatalf("concurrent recovery applied=%d, want1", appliedCount)
	}
	if applied, err := recovered.ApplyNextVoiceUsage(ctx); err != nil || applied {
		t.Fatalf("completed credit replayed=%v err=%v", applied, err)
	}
	used, err = repo.GetMonthlyUsage(ctx, "pending-instance", 2026, 1)
	if err != nil || used != 60 {
		t.Fatalf("recovered usage=%d err=%v", used, err)
	}
}
