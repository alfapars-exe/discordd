package repository

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestReminderStableIdentityReplaysWithoutDuplicateOrResurrection(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteReminderRepo(db.Conn)
	ctx := context.Background()
	item := models.MessageReminder{ID: "stable-request", UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "room", MessageID: "msg", DueAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second).Format(time.RFC3339)}
	start := make(chan struct{})
	results := make(chan error, 4)
	for range 4 {
		go func() { <-start; copy := item; results <- repo.Create(ctx, &copy) }()
	}
	close(start)
	for range 4 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if countRows(t, db, `SELECT COUNT(*) FROM message_reminders WHERE id=?`, item.ID) != 1 {
		t.Fatal("duplicate reminder")
	}
	changed := item
	changed.MessageID = "different"
	if err := repo.Create(ctx, &changed); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("changed replay: %v", err)
	}
	if ok, err := repo.Cancel(ctx, dmBob, item.ID); err != nil || !ok {
		t.Fatalf("cancel=%v %v", ok, err)
	}
	replay := item
	if err := repo.Create(ctx, &replay); err != nil || replay.Status != models.ReminderStatusCancelled {
		t.Fatalf("cancelled replay: %+v %v", replay, err)
	}
	foreign := item
	foreign.UserID = dmAlice
	if err := repo.Create(ctx, &foreign); err == nil {
		t.Fatal("foreign replay exposed owner data")
	}
}

func TestReminderRepositoryOwnershipLifecycleAndExactlyOnceDelivery(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteReminderRepo(db.Conn)
	ctx := context.Background()

	item := &models.MessageReminder{UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "dm-room", MessageID: "message-1", DueAt: time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)}
	if err := repo.Create(ctx, item); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := repo.GetByID(ctx, dmAlice, item.ID); err == nil {
		t.Fatal("foreign owner read succeeded")
	}
	if ok, err := repo.Cancel(ctx, dmAlice, item.ID); err != nil || ok {
		t.Fatalf("foreign cancel = %v, %v", ok, err)
	}

	var wg sync.WaitGroup
	results := make(chan []models.Notification, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := repo.DeliverDue(ctx, time.Now().UTC(), 10)
			results <- got
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("DeliverDue: %v", err)
		}
	}
	total := 0
	for got := range results {
		total += len(got)
	}
	if total != 1 {
		t.Fatalf("delivered notifications = %d, want exactly 1", total)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id = ? AND message_id = ?`, dmBob, "message-1"); n != 1 {
		t.Fatalf("notification rows = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM message_reminders WHERE id = ? AND status = 'delivered' AND notification_id IS NOT NULL`, item.ID); n != 1 {
		t.Fatal("reminder was not atomically delivered")
	}
}

func TestReminderRepositoryUpdateAndCancelOnlyScheduledOwner(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteReminderRepo(db.Conn)
	ctx := context.Background()
	item := &models.MessageReminder{UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "dm-room", MessageID: "message-2", DueAt: time.Now().UTC().Add(time.Hour).Format(time.RFC3339)}
	if err := repo.Create(ctx, item); err != nil {
		t.Fatal(err)
	}
	newDue := time.Now().UTC().Add(2 * time.Hour)
	if ok, err := repo.UpdateDue(ctx, dmBob, item.ID, newDue); err != nil || !ok {
		t.Fatalf("UpdateDue = %v, %v", ok, err)
	}
	if ok, err := repo.Cancel(ctx, dmBob, item.ID); err != nil || !ok {
		t.Fatalf("Cancel = %v, %v", ok, err)
	}
	if ok, err := repo.UpdateDue(ctx, dmBob, item.ID, newDue.Add(time.Hour)); err != nil || ok {
		t.Fatalf("cancelled update = %v, %v", ok, err)
	}
}

func TestReminderDeliveryRollbackAndRestartRecovery(t *testing.T) {
	// Inject an actual storage failure after the reminder has been claimed.
	// Both the claim and inbox write must roll back, allowing a later worker
	// instance to recover the reminder without losing or duplicating it.
	db, _ := newSQLiteTestDBWithPath(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	item := &models.MessageReminder{UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "room", MessageID: "recover-message", DueAt: now.Add(-time.Minute).Format(time.RFC3339)}
	repo := NewSQLiteReminderRepo(db.Conn)
	if err := repo.Create(ctx, item); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`CREATE TRIGGER fail_reminder_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.DeliverDue(ctx, now, 50); err == nil || len(got) != 0 {
		t.Fatalf("failed delivery = %+v, %v", got, err)
	}
	stored, err := repo.GetByID(ctx, dmBob, item.ID)
	if err != nil || stored.Status != models.ReminderStatusScheduled || stored.NotificationID != nil || stored.DeliveredAt != nil {
		t.Fatalf("failed transaction consumed reminder: %+v, %v", stored, err)
	}
	if _, err := db.Conn.Exec(`DROP TRIGGER fail_reminder_notification`); err != nil {
		t.Fatal(err)
	}
	// Reconstruct the repository as a restarted process would, with no memory
	// of the original request or failed delivery attempt.
	restarted := NewSQLiteReminderRepo(db.Conn)
	got, err := restarted.DeliverDue(ctx, now, 50)
	if err != nil || len(got) != 1 || got[0].DMChannelID == nil || *got[0].DMChannelID != "room" || got[0].ChannelID != nil {
		t.Fatalf("recovery delivery = %+v, %v", got, err)
	}
	again, err := NewSQLiteReminderRepo(db.Conn).DeliverDue(ctx, now.Add(time.Hour), 50)
	if err != nil || len(again) != 0 {
		t.Fatalf("duplicate after restart = %+v, %v", again, err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id=?`, item.MessageID); n != 1 {
		t.Fatalf("durable inbox rows = %d, want 1", n)
	}
}

func TestReminderDeliveryHonorsRescheduleCancellationAndBatch(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	repo := NewSQLiteReminderRepo(db.Conn)
	for _, id := range []string{"first", "second", "postponed", "cancelled", "future"} {
		due := now.Add(-time.Minute)
		if id == "future" {
			due = now.Add(time.Hour)
		}
		item := &models.MessageReminder{ID: id, UserID: dmBob, SourceKind: models.ReminderSourceDM, ChannelID: "room", MessageID: id, DueAt: due.Format(time.RFC3339)}
		if err := repo.Create(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	if ok, err := repo.UpdateDue(ctx, dmBob, "postponed", now.Add(time.Hour)); err != nil || !ok {
		t.Fatalf("postpone = %v, %v", ok, err)
	}
	if ok, err := repo.Cancel(ctx, dmBob, "cancelled"); err != nil || !ok {
		t.Fatalf("cancel = %v, %v", ok, err)
	}
	for _, want := range []string{"first", "second"} {
		got, err := repo.DeliverDue(ctx, now, 1)
		if err != nil || len(got) != 1 || got[0].MessageID == nil || *got[0].MessageID != want {
			t.Fatalf("batch want %s: %+v, %v", want, got, err)
		}
	}
	if got, err := repo.DeliverDue(ctx, now, 50); err != nil || len(got) != 0 {
		t.Fatalf("non-due delivery = %+v, %v", got, err)
	}
	if got, err := repo.DeliverDue(ctx, now.Add(time.Hour), 50); err != nil || len(got) != 2 {
		t.Fatalf("later delivery = %+v, %v", got, err)
	}
}
