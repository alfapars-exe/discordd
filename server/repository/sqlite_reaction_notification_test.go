package repository

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestReactionNotificationPersistentDedupe(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	actor, message := dmAlice, "reaction-message"
	makeNotification := func(emoji string) *models.Notification {
		payload, _ := json.Marshal(map[string]string{"subtype": "reaction", "emoji": emoji})
		return &models.Notification{UserID: dmBob, Kind: models.NotificationKindSystem, ActorID: &actor, MessageID: &message, Payload: payload}
	}
	first := makeNotification("👍")
	repo := NewSQLiteNotificationRepo(db.Conn).(*sqliteNotificationRepo)
	created, err := repo.CreateReactionIfAbsent(ctx, first, "👍")
	if err != nil || !created {
		t.Fatalf("first insert: %v %v", created, err)
	}
	assertRFC3339UTC(t, "reaction created_at", first.CreatedAt)
	// A fresh repository instance has no in-memory dedupe state.
	repo = NewSQLiteNotificationRepo(db.Conn).(*sqliteNotificationRepo)
	created, err = repo.CreateReactionIfAbsent(ctx, makeNotification("👍"), "👍")
	if err != nil || created {
		t.Fatalf("duplicate: %v %v", created, err)
	}
	created, err = repo.CreateReactionIfAbsent(ctx, makeNotification("❤️"), "❤️")
	if err != nil || !created {
		t.Fatalf("different emoji: %v %v", created, err)
	}
	if count := countRows(t, db, "SELECT COUNT(*) FROM notifications WHERE message_id = ?", message); count != 2 {
		t.Fatalf("rows=%d, want 2", count)
	}
	// Changing display wording must not change the delivery identity.
	reworded := makeNotification("👍")
	reworded.Payload = json.RawMessage(`{"subtype":"reaction","emoji":"👍","title":"Updated wording"}`)
	if created, err := repo.CreateReactionIfAbsent(ctx, reworded, "👍"); err != nil || created {
		t.Fatalf("reworded duplicate: %v %v", created, err)
	}
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			created, err := repo.CreateReactionIfAbsent(ctx, makeNotification("🎉"), "🎉")
			results <- created
			errors <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	createdCount := 0
	for created := range results {
		if created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent creates=%d, want 1", createdCount)
	}
}
