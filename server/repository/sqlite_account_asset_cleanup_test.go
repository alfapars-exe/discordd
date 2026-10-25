package repository

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAccountAssetCleanupConcurrentRetirementAndCompletionFailure(t *testing.T) {
	db, _, _ := authSessionRepoFixture(t)
	ctx := context.Background()
	now := time.Now().Unix()
	if _, err := db.Conn.Exec(`INSERT INTO account_asset_cleanup(file_url,requested_at) VALUES('/api/uploads/private.bin',?)`, now); err != nil {
		t.Fatal(err)
	}
	r := NewSQLiteAccountAssetCleanupRepo(wrapForRepo(db))
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.Process(ctx, "/api/uploads/private.bin", now, func() error {
				calls.Add(1)
				// Retirement is already committed before filesystem work starts.
				if _, err := db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/private.bin' WHERE id='session-other'`); err == nil {
					return fmt.Errorf("retirement not durable")
				}
				return nil
			})
			if err != nil {
				t.Errorf("process: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("removal calls=%d", calls.Load())
	}
	if _, err := db.Conn.Exec(`INSERT INTO account_asset_cleanup(file_url,requested_at) VALUES('/api/uploads/uncertain.bin',?)`, now); err != nil {
		t.Fatal(err)
	}
	installWriteFailure(t, db, "fail_cleanup_complete", "account_asset_cleanup", "UPDATE OF completed_at", "")
	outcome, err := r.Process(ctx, "/api/uploads/uncertain.bin", now, func() error { return nil })
	if err == nil || outcome != "retry" {
		t.Fatalf("uncertain completion %s %v", outcome, err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/uncertain.bin' WHERE id='session-other'`); err == nil {
		t.Fatal("failed completion reopened a removed URL")
	}
	dropFailureTrigger(t, db, "fail_cleanup_complete", "account_asset_cleanup")
	outcome, err = r.Process(ctx, "/api/uploads/uncertain.bin", now+61, func() error { return nil })
	if err != nil || outcome != "removed" {
		t.Fatalf("retry %s %v", outcome, err)
	}
}
