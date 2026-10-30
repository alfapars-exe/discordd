package services

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

func TestServerEventEmailWorkerToSenderSQLiteIntegration(t *testing.T) {
	for _, withdraw := range []bool{false, true} {
		t.Run(map[bool]string{false: "eligible", true: "withdrawn_before_send"}[withdraw], func(t *testing.T) {
			migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
			if err != nil {
				t.Fatal(err)
			}
			db, err := database.NewLegacy(filepath.Join(t.TempDir(), "event_email.db"), migrations)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })
			ctx := context.Background()
			for _, query := range []string{
				`INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES('event-user','event-user','x','event@example.test',1)`,
				`INSERT INTO servers(id,name,owner_id) VALUES('event-server','Test','event-user')`,
				`INSERT INTO server_members(server_id,user_id) VALUES('event-server','event-user')`,
				`INSERT INTO user_preferences(user_id,data) VALUES('event-user','{"notifications":{"upcomingEventNotifications":false},"email_preferences":{"social":true}}')`,
			} {
				if _, err := db.Conn.ExecContext(ctx, query); err != nil {
					t.Fatal(err)
				}
			}
			now := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
			events := repository.NewSQLiteServerEventRepo(database.NewRetryingQuerier(db.Conn))
			event := &models.ServerEvent{ServerID: "event-server", CreatorID: "event-user", Name: "Private title not for email", StartsAt: now.Add(8 * time.Minute).Format(time.RFC3339)}
			if err := events.Create(ctx, event); err != nil {
				t.Fatal(err)
			}
			if err := events.SetInterested(ctx, event.ID, "event-user", true); err != nil {
				t.Fatal(err)
			}
			worker := NewServerEventWorker(repository.NewSQLiteServerEventDeliveryRepo(database.NewRetryingQuerier(db.Conn)), &testutil.MockBroadcaster{})
			worker.now = func() time.Time { return now }
			if err := worker.Drain(ctx); err != nil {
				t.Fatal(err)
			}
			if err := worker.Drain(ctx); err != nil {
				t.Fatal(err)
			}
			var jobs, notices int
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM email_delivery_jobs`).Scan(&jobs); err != nil {
				t.Fatal(err)
			}
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&notices); err != nil {
				t.Fatal(err)
			}
			if jobs != 1 || notices != 0 {
				t.Fatalf("jobs=%d notices=%d; want 1,0", jobs, notices)
			}
			if withdraw {
				if err := events.SetInterested(ctx, event.ID, "event-user", false); err != nil {
					t.Fatal(err)
				}
			}
			sender := &integrationCategorySender{}
			service := NewEmailDeliveryService(repository.NewSQLiteEmailDeliveryRepo(db.Conn), sender, WithEmailUnsubscribe(repository.NewSQLiteEmailUnsubscribeRepo(db.Conn), "https://app.example.test"))
			delivered, err := service.DeliverBatch(ctx, now)
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if withdraw {
				want = 0
			}
			if delivered != want || sender.sends != want {
				t.Fatalf("delivered=%d sends=%d; want %d", delivered, sender.sends, want)
			}
			if !withdraw && (sender.to != "event@example.test" || !strings.Contains(sender.body, "/api/email/unsubscribe?token=") || strings.Contains(sender.body, event.Name)) {
				t.Fatal("eligible event email lacks unsubscribe or contains event title")
			}
			var status string
			if err := db.Conn.QueryRow(`SELECT status FROM email_delivery_jobs`).Scan(&status); err != nil {
				t.Fatal(err)
			}
			wantStatus := "delivered"
			if withdraw {
				wantStatus = "cancelled"
			}
			if status != wantStatus {
				t.Fatalf("status=%s want %s", status, wantStatus)
			}
		})
	}
}
