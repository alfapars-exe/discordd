package repository

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func mfaRepoFixture(t *testing.T) MFARepository {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('mfa-user','mfa_test','hash')`}})
	return NewSQLiteMFARepo(wrapForRepo(db))
}

func TestSQLiteMFASetupCASAndExpiry(t *testing.T) {
	r := mfaRepoFixture(t)
	ctx := context.Background()
	if ok, err := r.ReserveAttempt(ctx, "mfa-user", 1000); err != nil || !ok {
		t.Fatal(err)
	}
	if ok, err := r.Prepare(ctx, "mfa-user", "encrypted-a", "setup-a", 1600); err != nil || !ok {
		t.Fatal(err)
	}
	if ok, err := r.Prepare(ctx, "mfa-user", "encrypted-b", "setup-b", 1600); err != nil || !ok {
		t.Fatal(err)
	}
	if ok, err := r.Enable(ctx, "mfa-user", "setup-a", 1100, 37, []string{"hash"}); err != nil || ok {
		t.Fatalf("superseded setup: %v %v", ok, err)
	}
	if ok, err := r.Enable(ctx, "mfa-user", "setup-b", 1600, 53, []string{"hash"}); err != nil || ok {
		t.Fatalf("expired setup: %v %v", ok, err)
	}
	if ok, err := r.Enable(ctx, "mfa-user", "setup-b", 1100, 37, []string{"hash"}); err != nil || !ok {
		t.Fatalf("enable: %v %v", ok, err)
	}
	if ok, _ := r.Prepare(ctx, "mfa-user", "encrypted-c", "setup-c", 1700); ok {
		t.Fatal("must not replace enabled secret")
	}
	record, err := r.Get(ctx, "mfa-user")
	if err != nil || record.Secret != "encrypted-b" || record.PendingSecret != "" || record.RecoveryRemaining != 1 {
		t.Fatalf("record=%+v err=%v", record, err)
	}
	if ok, _ := r.ConsumeTOTP(ctx, "mfa-user", "encrypted-b", 37); ok {
		t.Fatal("enrollment code replay")
	}
	if ok, _ := r.ConsumeTOTP(ctx, "mfa-user", "wrong-secret", 38); ok {
		t.Fatal("stale secret accepted")
	}
	if ok, _ := r.ConsumeTOTP(ctx, "mfa-user", "encrypted-b", 38); !ok {
		t.Fatal("next step rejected")
	}
}

func TestSQLiteMFARecoveryAtomicSingleUseAndReplace(t *testing.T) {
	r := mfaRepoFixture(t)
	ctx := context.Background()
	_, _ = r.ReserveAttempt(ctx, "mfa-user", 1000)
	_, _ = r.Prepare(ctx, "mfa-user", "encrypted", "setup", 2000)
	_, _ = r.Enable(ctx, "mfa-user", "setup", 1000, 33, []string{"once", "old"})
	var winners atomic.Int32
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := r.ConsumeRecovery(ctx, "mfa-user", "encrypted", "once")
			if err != nil {
				t.Error(err)
			}
			if ok {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("recovery winners=%d", winners.Load())
	}
	if ok, err := r.ReplaceRecovery(ctx, "mfa-user", "encrypted", 1, []string{"new"}); err != nil || !ok {
		t.Fatal(err)
	}
	if ok, err := r.ReplaceRecovery(ctx, "mfa-user", "encrypted", 1, []string{"stale-concurrent-generation"}); err != nil || ok {
		t.Fatal("two old-version requests both replaced current codes")
	}
	if ok, _ := r.ConsumeRecovery(ctx, "mfa-user", "encrypted", "old"); ok {
		t.Fatal("old generation remained valid")
	}
	if ok, _ := r.Disable(ctx, "mfa-user", "encrypted"); !ok {
		t.Fatal("disable failed")
	}
	if ok, _ := r.ConsumeRecovery(ctx, "mfa-user", "encrypted", "new"); ok {
		t.Fatal("disabled recovery remained valid")
	}
	record, err := r.Get(ctx, "mfa-user")
	if err != nil || record.Secret != "" || record.RecoveryRemaining != 0 {
		t.Fatal("disable retained secrets")
	}
}

func TestSQLiteMFASharedDurableAttemptBudget(t *testing.T) {
	r := mfaRepoFixture(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if ok, err := r.ReserveAttempt(ctx, "mfa-user", 1000); err != nil || !ok {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if ok, err := r.ReserveAttempt(ctx, "mfa-user", 1299); err != nil || ok {
		t.Fatalf("budget bypass: %v %v", ok, err)
	}
	if ok, err := r.ReserveAttempt(ctx, "mfa-user", 1300); err != nil || !ok {
		t.Fatalf("budget not reset: %v %v", ok, err)
	}
}

func TestSQLiteMFACancelOnlyMatchingPendingSetup(t *testing.T) {
	r := mfaRepoFixture(t)
	ctx := context.Background()
	_, _ = r.ReserveAttempt(ctx, "mfa-user", 1000)
	_, _ = r.Prepare(ctx, "mfa-user", "encrypted", "setup", 1600)
	if ok, _ := r.CancelSetup(ctx, "mfa-user", "stale"); ok {
		t.Fatal("cancelled another setup")
	}
	if ok, err := r.CancelSetup(ctx, "mfa-user", "setup"); err != nil || !ok {
		t.Fatal("cancel failed")
	}
	if ok, _ := r.Enable(ctx, "mfa-user", "setup", 1100, 36, []string{"hash"}); ok {
		t.Fatal("cancelled setup can still enable")
	}
	_, _ = r.Prepare(ctx, "mfa-user", "encrypted", "new-setup", 1600)
	_, _ = r.Enable(ctx, "mfa-user", "new-setup", 1100, 36, []string{"hash"})
	if ok, _ := r.CancelSetup(ctx, "mfa-user", "new-setup"); ok {
		t.Fatal("cancel removed enabled MFA")
	}
}
