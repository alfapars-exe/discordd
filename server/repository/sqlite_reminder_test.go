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
