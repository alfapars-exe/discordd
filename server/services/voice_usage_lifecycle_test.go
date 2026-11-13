package services

import (
	"context"
	"github.com/argeinfina/hichat/repository"
	"testing"
	"time"
)

func TestVoiceUsageCreditHasBoundedContext(t *testing.T) {
	calls := 0
	var observed context.Context
	s := &voiceService{livekitGetter: &mockConfigurableLiveKitGetter{IncrementMonthlyUsageFn: func(ctx context.Context, _ string, _, _, seconds int) error {
		calls++
		observed = ctx
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Error("usage credit database call has no deadline")
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || remaining > 10*time.Second {
			t.Errorf("usage credit deadline outside bounded budget: %s", remaining)
		}
		if seconds < 59 {
			t.Errorf("session duration lost: %d", seconds)
		}
		return nil
	}}}
	s.creditUsage("instance", true, time.Now().Add(-time.Minute))
	if observed == nil || observed.Err() != context.Canceled {
		t.Error("usage context not released on return")
	}
	if calls != 1 {
		t.Fatalf("usage writes=%d, want 1", calls)
	}
}

func TestVoiceUsageCreditPostgresDeadline(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('credit-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.ExecContext(ctx, "LOCK TABLE livekit_monthly_usage IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	s := &voiceService{livekitGetter: repository.NewSQLiteLiveKitRepo(db)}
	done := make(chan struct{})
	go func() { s.creditUsage("credit-instance", true, time.Now().Add(-time.Minute)); close(done) }()
	for {
		var waiting bool
		if err := blocker.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation='livekit_monthly_usage'::regclass AND NOT granted)").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("usage credit never reached PostgreSQL lock wait")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("credit query exceeded its ten-second operation deadline")
	}
	if _, err = blocker.ExecContext(ctx, "SELECT 1"); err != nil {
		t.Fatalf("credit cancellation invalidated held transaction: %v", err)
	}
	var rows int
	if err = blocker.QueryRowContext(ctx, "SELECT count(*) FROM livekit_monthly_usage").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("cancelled credit wrote %d rows", rows)
	}
}

func TestVoiceUsageCreditPostgresAdditiveWrites(t *testing.T) {
	db := postgresServerFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, `INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('credit-instance','http://127.0.0.1','fixture','fixture')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteLiveKitRepo(db)
	for i := 0; i < 2; i++ {
		if err := repo.IncrementMonthlyUsage(ctx, "credit-instance", 2026, 1, 60); err != nil {
			t.Fatal(err)
		}
	}
	used, err := repo.GetMonthlyUsage(ctx, "credit-instance", 2026, 1)
	if err != nil {
		t.Fatal(err)
	}
	if used != 120 {
		t.Fatalf("two independent credits total=%d, want 120", used)
	}
}

func TestVoiceUsageCreditUsesCapturedSessionEnd(t *testing.T) {
	ended := time.Date(2026, time.January, 31, 23, 59, 59, 0, time.UTC)
	calls := 0
	s := &voiceService{livekitGetter: &mockConfigurableLiveKitGetter{IncrementMonthlyUsageFn: func(_ context.Context, _ string, year, month, seconds int) error {
		calls++
		if year != 2026 || month != 1 || seconds != 60 {
			t.Errorf("credit=(%d,%d,%d), want captured January session of60s", year, month, seconds)
		}
		return nil
	}}}
	s.creditUsageUntil("instance", true, ended.Add(-time.Minute), ended)
	s.creditUsageUntil("instance", true, ended.Add(time.Second), ended)
	if calls != 1 {
		t.Fatalf("usage writes=%d, want1; negative duration must not write", calls)
	}
}
