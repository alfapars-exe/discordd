package repository

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"os"
	"testing"
	"time"
)

func TestEmailAttemptLeasePersistenceAndPrivacy(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewSQLiteEmailDeliveryRepo(db.Conn)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('attempt-user','attempt-user','x','to@example.test',1)`}})
	job := &models.EmailDeliveryJob{UserID: "attempt-user", Category: models.EmailCategorySocial, DedupeKey: "attempt", Subject: "subject", BodyHTML: "body"}
	if ok, err := r.EnqueueIfEligible(ctx, job); err != nil || !ok {
		t.Fatalf("enqueue %v", err)
	}
	now := time.Now().Add(time.Second)
	jobs, err := r.ClaimDue(ctx, now, 1)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("claim %v", err)
	}
	j := jobs[0]
	p := models.EmailDeliveryPayload{From: "sender", To: j.Address, Subject: j.Subject, HTML: "final with proof"}
	a, err := r.PrepareAttempt(ctx, &j, p, now)
	if err != nil || a.Payload != p {
		t.Fatalf("prepare %v", err)
	}
	stale := j
	stale.ClaimToken = "stale"
	if err = r.FinishAttempt(ctx, &stale, "provider", "delivered", now); !errors.Is(err, ErrStaleEmailDeliveryClaim) {
		t.Fatalf("stale ack %v", err)
	}
	if allowed, err := r.CanDeliver(ctx, &stale, now); err != nil || allowed {
		t.Fatalf("stale sender eligibility %v", err)
	}
	if err = r.Retry(ctx, j.ID, j.ClaimToken, "lost response", now, 5); err != nil {
		t.Fatal(err)
	}
	jobs, err = r.ClaimDue(ctx, now, 1)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("reclaim %v", err)
	}
	saved, err := r.ReadAttempt(ctx, j.ID)
	if err != nil || *saved != *a {
		t.Fatal("payload changed")
	}
	if err = r.FinishAttempt(ctx, &jobs[0], "provider", "delivered", now); err != nil {
		t.Fatal(err)
	}
	saved, err = r.ReadAttempt(ctx, j.ID)
	if err != nil || saved.ProviderID != "provider" || saved.Outcome != "delivered" {
		t.Fatal("missing provider receipt")
	}
	if _, err = db.Conn.ExecContext(ctx, `DELETE FROM users WHERE id='attempt-user'`); err != nil {
		t.Fatal(err)
	}
	if saved, err = r.ReadAttempt(ctx, j.ID); err != nil || saved != nil {
		t.Fatal("sensitive payload survived account deletion")
	}
}

func TestEmailAttemptMigrationQuarantinesLegacyAttempts(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('legacy-mail','legacy-mail','x','to@example.test',1)`}})
	r := NewSQLiteEmailDeliveryRepo(db.Conn)
	for _, key := range []string{"fresh", "attempted"} {
		if ok, err := r.EnqueueIfEligible(ctx, &models.EmailDeliveryJob{UserID: "legacy-mail", Category: models.EmailCategorySocial, DedupeKey: key, Subject: "subject", BodyHTML: "body"}); err != nil || !ok {
			t.Fatal(err)
		}
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE email_delivery_jobs SET attempts=1 WHERE dedupe_key='attempted'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.ExecContext(ctx, `DROP TABLE email_delivery_attempts`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../database/postgres_migrations/050_email_provider_idempotency.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Conn.ExecContext(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE dedupe_key='fresh' AND status='pending'`); n != 1 {
		t.Fatal("fresh job quarantined")
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_attempts a JOIN email_delivery_jobs j ON j.id=a.job_id WHERE a.outcome='review' AND j.status='cancelled' AND j.dedupe_key='attempted'`); n != 1 {
		t.Fatal("legacy attempt not quarantined")
	}
}
