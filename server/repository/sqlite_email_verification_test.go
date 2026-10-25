package repository

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSQLiteEmailVerificationGenerationAndSingleUse(t *testing.T) {
	db, _, _ := authSessionRepoFixture(t)
	r := NewSQLiteEmailVerificationRepo(wrapForRepo(db))
	users := NewSQLiteUserRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	address := "first@example.invalid"
	if err := users.UpdateEmail(ctx, "session-user", &address); err != nil {
		t.Fatal(err)
	}
	status, err := r.Status(ctx, "session-user", now)
	if err != nil || status.Verified || status.Generation != 1 {
		t.Fatalf("new email %+v %v", status, err)
	}
	if ok, err := r.Reserve(ctx, "session-user", status.Generation, "proof-one", now, now+1200); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := r.Reserve(ctx, "session-user", status.Generation, "spam", now+1, now+1201); ok {
		t.Fatal("cooldown bypassed")
	}
	if err := users.UpdateEmail(ctx, "session-user", nil); err != nil {
		t.Fatal(err)
	}
	if err := users.UpdateEmail(ctx, "session-user", &address); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.Consume(ctx, "proof-one", now+2); err != nil || ok {
		t.Fatal("address ABA revived proof", err)
	}
	status, err = r.Status(ctx, "session-user", now+61)
	if err != nil || status.Generation != 3 {
		t.Fatalf("generation %+v %v", status, err)
	}
	if ok, err := r.Reserve(ctx, "session-user", status.Generation, "proof-two", now+61, now+1261); err != nil || !ok {
		t.Fatal(ok, err)
	}
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := r.Consume(ctx, "proof-two", now+62)
			if err != nil {
				t.Error(err)
			}
			if ok {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("consumers=%d", wins.Load())
	}
	status, err = r.Status(ctx, "session-user", now+63)
	if err != nil || !status.Verified || status.VerifiedAt == nil {
		t.Fatalf("verified %+v %v", status, err)
	}
	other, err := r.Status(ctx, "session-other", now+63)
	if err != nil || other.Verified {
		t.Fatal("verification crossed account", err)
	}
}
func TestSQLiteEmailVerificationExpiryAndRollback(t *testing.T) {
	db, _, _ := authSessionRepoFixture(t)
	r := NewSQLiteEmailVerificationRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	if _, err := db.Conn.Exec(`UPDATE users SET email='verify@example.invalid' WHERE id='session-user'`); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.Reserve(ctx, "session-user", 1, "expired", now, now+1); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := r.Consume(ctx, "expired", now+1); err != nil || ok {
		t.Fatal("expiry boundary accepted", err)
	}
	if ok, err := r.Reserve(ctx, "session-user", 1, "live", now+61, now+1200); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, err := db.Conn.Exec(`CREATE TRIGGER fail_verify BEFORE DELETE ON account_email_tokens BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.Consume(ctx, "live", now+62); err == nil || ok {
		t.Fatal("failed proof deletion reported verification")
	}
	status, err := r.Status(ctx, "session-user", now+62)
	if err != nil || status.Verified {
		t.Fatal("verification escaped rollback", err)
	}
	if _, err := db.Conn.Exec(`DROP TRIGGER fail_verify`); err != nil {
		t.Fatal(err)
	}
	if ok, err := r.Consume(ctx, "live", now+63); err != nil || !ok {
		t.Fatal("proof lost on rollback", err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET email='new@example.invalid' WHERE id='session-user'`); err != nil {
		t.Fatal(err)
	}
	status, _ = r.Status(ctx, "session-user", now+64)
	if status.Verified || status.Generation != 2 {
		t.Fatal("new address retained old verification")
	}
}
