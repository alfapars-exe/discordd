package repository

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

// Hold an uncommitted postponement while DeliverDue reads the old due time.
// PostgreSQL's observed lock wait proves the SELECT finished before we commit;
// no scheduler timing assumption is used to create the race.
func TestReminderPostgresDeliveryRechecksConcurrentPostponement(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	db, _ := newPostgresTestDB(t, dsn)
	seedDMUsers(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Second)
	future := now.Add(time.Hour)
	repo := NewSQLiteReminderRepo(db.Conn)
	item := &models.MessageReminder{ID: "concurrent-postpone", UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "room", MessageID: "race-message", DueAt: now.Add(-time.Minute).Format(time.RFC3339)}
	if err := repo.Create(ctx, item); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var ownerPID int
	if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&ownerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE message_reminders SET due_at=? WHERE id=?`, reminderTime(future), item.ID); err != nil {
		t.Fatal(err)
	}
	type deliveryResult struct {
		notifications []models.Notification
		err           error
	}
	done := make(chan deliveryResult, 1)
	go func() { got, err := repo.DeliverDue(ctx, now, 50); done <- deliveryResult{got, err} }()
	for {
		var waiting bool
		err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE message_reminders SET status=%')`, ownerPID).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case result := <-done:
			t.Fatalf("delivery finished before blocked claim: %+v", result)
		case <-ctx.Done():
			t.Fatal("delivery claim was never observed blocked behind postponement")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil || len(result.notifications) != 0 {
		t.Fatalf("postponed delivery = %+v, %v", result.notifications, result.err)
	}
	stored, err := repo.GetByID(ctx, dmBob, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != models.ReminderStatusScheduled || stored.DueAt != future.Format(time.RFC3339) || stored.NotificationID != nil || stored.DeliveredAt != nil {
		t.Fatalf("postponement lost: %+v", stored)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, item.MessageID); n != 0 {
		t.Fatalf("premature notifications = %d", n)
	}
	got, err := repo.DeliverDue(ctx, future, 50)
	if err != nil || len(got) != 1 {
		t.Fatalf("delivery at postponed time = %+v, %v", got, err)
	}
	got, err = repo.DeliverDue(ctx, future, 50)
	if err != nil || len(got) != 0 {
		t.Fatalf("duplicate delivery = %+v, %v", got, err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, item.MessageID); n != 1 {
		t.Fatalf("final notifications = %d", n)
	}
}
