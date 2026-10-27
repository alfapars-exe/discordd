package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func makeDeliverableEvent(t *testing.T, ctx context.Context, repo ServerEventRepository, name string, starts time.Time) *models.ServerEvent {
	t.Helper()
	channelID := "event-text"
	event := eventFixture(name, starts.UTC().Format(time.RFC3339Nano))
	event.ChannelID = &channelID
	if err := repo.Create(ctx, event); err != nil {
		t.Fatalf("create event: %v", err)
	}
	if err := repo.SetInterested(ctx, event.ID, dmBob, true); err != nil {
		t.Fatalf("set interested: %v", err)
	}
	return event
}

func TestServerEventDeliveryDueCandidatesAndPaging(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	for _, test := range []struct {
		id, name string
		start    time.Time
		status   string
	}{
		{"event-a", "Due soon A", now.Add(5 * time.Minute), models.ServerEventStatusScheduled},
		{"event-b", "Due soon B", now.Add(10 * time.Minute), models.ServerEventStatusScheduled},
		{"event-c", "Too late", now.Add(16 * time.Minute), models.ServerEventStatusScheduled},
		{"event-d", "Already started", now.Add(-time.Minute), models.ServerEventStatusScheduled},
		{"event-e", "Cancelled", now.Add(5 * time.Minute), models.ServerEventStatusCancelled},
	} {
		event := eventFixture(test.name, test.start.Format(time.RFC3339Nano))
		event.ID, event.Status, event.Version = test.id, models.ServerEventStatusScheduled, 1
		if err := events.Create(ctx, event); err != nil {
			t.Fatalf("create %s: %v", test.id, err)
		}
		if test.status == models.ServerEventStatusCancelled {
			if ok, err := events.CancelCAS(ctx, event.ServerID, event.ID, event.Version); err != nil || !ok {
				t.Fatalf("cancel %s: %v, %v", test.id, ok, err)
			}
		}
	}
	page, err := delivery.DueCandidates(ctx, now, 1, "")
	if err != nil || len(page) != 1 || page[0].ID != "event-a" {
		t.Fatalf("first due page = %+v, %v", page, err)
	}
	page, err = delivery.DueCandidates(ctx, now, 10, page[0].ID)
	if err != nil || len(page) != 1 || page[0].ID != "event-b" {
		t.Fatalf("second due page = %+v, %v", page, err)
	}
	page, err = delivery.DueCandidates(ctx, now, 10, "event-b")
	if err != nil || len(page) != 0 {
		t.Fatalf("end due page = %+v, %v", page, err)
	}
}

func TestServerEventDeliveryCommitsDedupedNotificationWithoutChannelAssociation(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Private-channel meetup", now.Add(5*time.Minute))
	first, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
	if err != nil || first == nil {
		t.Fatalf("Deliver first = %+v, %v", first, err)
	}
	if first.Kind != models.NotificationKindSystem || first.ServerID == nil || *first.ServerID != event.ServerID || first.ChannelID != nil {
		t.Fatalf("notification scope = %+v", first)
	}
	var payload map[string]any
	if err := json.Unmarshal(first.Payload, &payload); err != nil {
		t.Fatalf("payload JSON: %v", err)
	}
	if payload["action"] != "server_event_upcoming" || payload["event_id"] != event.ID || payload["title"] != event.Name || payload["channel_id"] != nil || payload["channel"] != nil {
		t.Fatalf("notification payload exposes wrong fields: %s", first.Payload)
	}
	second, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
	if err != nil || second != nil {
		t.Fatalf("duplicate Deliver = %+v, %v; want nil,nil", second, err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND server_id=? AND kind='system'`, dmBob, event.ServerID); n != 1 {
		t.Fatalf("system notifications = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=? AND notification_id IS NOT NULL`, event.ID, dmBob); n != 1 {
		t.Fatalf("delivery dedupe rows = %d, want 1", n)
	}
}

func TestServerEventDeliveryRechecksMembershipRSVPAndPreference(t *testing.T) {
	for _, scenario := range []string{"member_removed", "rsvp_withdrawn", "preference_off", "preference_null", "event_cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			db := newTestDB(t)
			seedEventServer(t, db)
			events := NewSQLiteServerEventRepo(wrapForRepo(db))
			delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
			ctx := context.Background()
			now := time.Now().UTC().Truncate(time.Second)
			event := makeDeliverableEvent(t, ctx, events, "Test", now.Add(5*time.Minute))
			switch scenario {
			case "member_removed":
				if _, err := db.Conn.Exec(`DELETE FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob); err != nil {
					t.Fatal(err)
				}
			case "rsvp_withdrawn":
				if err := events.SetInterested(ctx, event.ID, dmBob, false); err != nil {
					t.Fatal(err)
				}
			case "preference_off":
				if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, dmBob, `{"notifications":{"upcomingEventNotifications":false}}`); err != nil {
					t.Fatal(err)
				}
			case "preference_null":
				if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, dmBob, `null`); err != nil {
					t.Fatal(err)
				}
			case "event_cancelled":
				if ok, err := events.CancelCAS(ctx, event.ServerID, event.ID, event.Version); err != nil || !ok {
					t.Fatalf("CancelCAS = %v, %v", ok, err)
				}
			}
			got, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
			if err != nil || got != nil {
				t.Fatalf("Deliver ineligible scenario = %+v, %v; want nil,nil", got, err)
			}
			wantDedupe := 0
			if scenario == "preference_off" || scenario == "preference_null" {
				// The app notification preference is channel-specific; its off or
				// malformed state must not prevent independent email evaluation.
				wantDedupe = 1
			}
			if n := countRows(t, db, `SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, event.ID, dmBob); n != wantDedupe {
				t.Fatalf("delivery dedupe rows = %d, want %d", n, wantDedupe)
			}
		})
	}
}

func TestServerEventDeliveryQueuesGenericSocialEmailAtomicallyAndIndependently(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Private channel meetup", now.Add(5*time.Minute))
	if _, err := db.Conn.Exec(`UPDATE users SET email='bob@example.test' WHERE id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET email_verified_at=1 WHERE id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, dmBob, `{"notifications":{"upcomingEventNotifications":false},"email_preferences":{"social":true}}`); err != nil {
		t.Fatal(err)
	}

	notification, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
	if err != nil || notification != nil {
		t.Fatalf("Deliver with app notifications off = %+v, %v; want email-only delivery", notification, err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind='system'`, dmBob); got != 0 {
		t.Fatalf("in-app notices = %d, want 0", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE user_id=? AND category='social'`, dmBob); got != 1 {
		t.Fatalf("event email jobs = %d, want 1", got)
	}
	var subject, body, dedupe, queuedStart string
	var queuedEvent sql.NullString
	if err := db.Conn.QueryRow(`SELECT subject,body_html,dedupe_key,server_event_id,CAST(server_event_starts_at AS TEXT) FROM email_delivery_jobs WHERE user_id=? AND category='social'`, dmBob).Scan(&subject, &body, &dedupe, &queuedEvent, &queuedStart); err != nil {
		t.Fatal(err)
	}
	if queuedEvent.String != event.ID || !strings.HasPrefix(dedupe, "server-event:"+event.ID+":") || queuedStart == "" {
		t.Fatalf("email occurrence context/dedupe = %q %q %q", queuedEvent.String, dedupe, queuedStart)
	}
	if strings.Contains(subject+body, event.Name) || strings.Contains(subject+body, "event-text") {
		t.Fatalf("queued email leaks mutable event/channel details: %q %q", subject, body)
	}
	if _, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM email_delivery_jobs WHERE user_id=? AND category='social'`, dmBob); got != 1 {
		t.Fatalf("duplicate event email jobs = %d, want 1", got)
	}

	job := &models.EmailDeliveryJob{UserID: dmBob, Category: models.EmailCategorySocial, Address: "bob@example.test", ServerEventID: event.ID, ServerEventStartsAt: event.StartsAt}
	allowed, err := NewSQLiteEmailDeliveryRepo(db.Conn).CanDeliver(ctx, job, now)
	if err != nil || !allowed {
		t.Fatalf("eligible event email CanDeliver = %v, %v", allowed, err)
	}
}

func TestServerEventEmailEnqueueFailureRollsBackOccurrenceDelivery(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Rollback email", now.Add(5*time.Minute))
	if _, err := db.Conn.Exec(`UPDATE users SET email='bob@example.test' WHERE id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET email_verified_at=1 WHERE id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	if database.IsPostgres(db.Conn) {
		_, err := db.Conn.Exec(`CREATE FUNCTION fail_event_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER fail_event_email BEFORE INSERT ON email_delivery_jobs FOR EACH ROW WHEN (NEW.server_event_id IS NOT NULL) EXECUTE FUNCTION fail_event_email()`)
		if err != nil {
			t.Fatal(err)
		}
	} else if _, err := db.Conn.Exec(`CREATE TRIGGER fail_event_email BEFORE INSERT ON email_delivery_jobs WHEN NEW.server_event_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now); err == nil {
		t.Fatal("expected transactional email enqueue failure")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, event.ID, dmBob); got != 0 {
		t.Fatalf("event dedupe survived email failure: %d", got)
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind='system'`, dmBob); got != 0 {
		t.Fatalf("app notice survived email failure: %d", got)
	}
}

func TestServerEventEmailSendEligibilityTracksOccurrenceAndConsent(t *testing.T) {
	for _, scenario := range []string{"rsvp_withdrawn", "member_removed", "event_cancelled", "rescheduled", "same_start_edit", "email_opt_out", "malformed_email_preferences", "address_changed", "user_disabled", "account_deleted"} {
		t.Run(scenario, func(t *testing.T) {
			db := newTestDB(t)
			seedEventServer(t, db)
			events := NewSQLiteServerEventRepo(wrapForRepo(db))
			delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
			ctx := context.Background()
			now := time.Now().UTC().Truncate(time.Second)
			event := makeDeliverableEvent(t, ctx, events, "Eligibility", now.Add(8*time.Minute))
			if _, err := db.Conn.Exec(`UPDATE users SET email='bob@example.test' WHERE id=?`, dmBob); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Conn.Exec(`UPDATE users SET email_verified_at=1 WHERE id=?`, dmBob); err != nil {
				t.Fatal(err)
			}
			if _, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now); err != nil {
				t.Fatal(err)
			}
			var job models.EmailDeliveryJob
			job.Address = "bob@example.test"
			if err := db.Conn.QueryRow(`SELECT user_id,category,server_event_id,CAST(server_event_starts_at AS TEXT) FROM email_delivery_jobs WHERE user_id=?`, dmBob).Scan(&job.UserID, &job.Category, &job.ServerEventID, &job.ServerEventStartsAt); err != nil {
				t.Fatalf("queued event job: %v", err)
			}
			switch scenario {
			case "rsvp_withdrawn":
				if err := events.SetInterested(ctx, event.ID, dmBob, false); err != nil {
					t.Fatal(err)
				}
			case "member_removed":
				if _, err := db.Conn.Exec(`DELETE FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob); err != nil {
					t.Fatal(err)
				}
			case "event_cancelled":
				if ok, err := events.CancelCAS(ctx, event.ServerID, event.ID, event.Version); err != nil || !ok {
					t.Fatalf("CancelCAS = %v, %v", ok, err)
				}
			case "rescheduled":
				if _, err := db.Conn.Exec(`UPDATE server_events SET starts_at=?,version=version+1 WHERE id=?`, now.Add(9*time.Minute).Format(time.RFC3339Nano), event.ID); err != nil {
					t.Fatal(err)
				}
			case "same_start_edit":
				if _, err := db.Conn.Exec(`UPDATE server_events SET name='Edited',version=version+1 WHERE id=?`, event.ID); err != nil {
					t.Fatal(err)
				}
			case "address_changed":
				if _, err := db.Conn.Exec(`UPDATE users SET email='new-bob@example.test' WHERE id=?`, dmBob); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Conn.Exec(`UPDATE users SET email_verified_at=1 WHERE id=?`, dmBob); err != nil {
					t.Fatal(err)
				}
			case "email_opt_out":
				if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, dmBob, `{"email_preferences":{"social":false}}`); err != nil {
					t.Fatal(err)
				}
			case "malformed_email_preferences":
				if _, err := db.Conn.Exec(`INSERT INTO user_preferences(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`, dmBob, `{"email_preferences":{"social":"yes"}}`); err != nil {
					t.Fatal(err)
				}
			case "user_disabled":
				if _, err := db.Conn.Exec(`INSERT INTO account_lifecycle(user_id,disabled_at) VALUES(?,?)`, dmBob, time.Now().Unix()); err != nil {
					t.Fatal(err)
				}
			case "account_deleted":
				if _, err := db.Conn.Exec(`UPDATE users SET deleted_at=? WHERE id=?`, time.Now().Unix(), dmBob); err != nil {
					t.Fatal(err)
				}
			}
			allowed, err := NewSQLiteEmailDeliveryRepo(db.Conn).CanDeliver(ctx, &job, now)
			if scenario == "same_start_edit" {
				if err != nil || !allowed {
					t.Fatalf("CanDeliver after same-start edit = %v, %v; want allowed", allowed, err)
				}
				return
			}
			if err != nil || allowed {
				t.Fatalf("CanDeliver after %s = %v, %v; want suppressed", scenario, allowed, err)
			}
		})
	}
}

func TestServerEventDeliveryNotificationFailureRollsBackDedupe(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Rollback", now.Add(5*time.Minute))
	if database.IsPostgres(db.Conn) {
		_, err := db.Conn.Exec(`CREATE FUNCTION fail_event_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER fail_event_notice BEFORE INSERT ON notifications FOR EACH ROW WHEN (NEW.kind='system') EXECUTE FUNCTION fail_event_notice()`)
		if err != nil {
			t.Fatal(err)
		}
	} else if _, err := db.Conn.Exec(`CREATE TRIGGER fail_event_notice BEFORE INSERT ON notifications WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now); err == nil {
		t.Fatal("expected notification insert failure")
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, event.ID, dmBob); n != 0 {
		t.Fatalf("dedupe row survived rollback: %d", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind='system'`, dmBob); n != 0 {
		t.Fatalf("notification survived rollback: %d", n)
	}
}

func TestServerEventDeliveryConcurrentWorkersCreateOneNotification(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Concurrent", now.Add(5*time.Minute))
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan *models.Notification, 2)
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			n, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
			results <- n
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	created, nulls := 0, 0
	for n := range results {
		if n == nil {
			nulls++
		} else {
			created++
		}
	}
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent delivery: %v", err)
		}
	}
	if created != 1 || nulls != 1 {
		t.Fatalf("concurrent winners created=%d nil=%d, want 1/1", created, nulls)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_event_deliveries WHERE event_id=? AND user_id=?`, event.ID, dmBob); n != 1 {
		t.Fatalf("delivery rows = %d, want 1", n)
	}
}

func TestPostgresServerEventDeliverySerializesEligibilityChanges(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires isolated PostgreSQL row-lock fixture")
	}
	for _, scenario := range []struct {
		name          string
		lockQuery     string
		prepareWriter func(context.Context, *sql.Tx, string) error
	}{
		{
			name:      "event_cancelled",
			lockQuery: "UPDATE server_events SET status=status",
			prepareWriter: func(ctx context.Context, tx *sql.Tx, eventID string) error {
				_, err := tx.ExecContext(ctx, `UPDATE server_events SET status='cancelled',version=version+1 WHERE id=?`, eventID)
				return err
			},
		},
		{
			name:      "event_rescheduled",
			lockQuery: "UPDATE server_events SET status=status",
			prepareWriter: func(ctx context.Context, tx *sql.Tx, eventID string) error {
				_, err := tx.ExecContext(ctx, `UPDATE server_events SET starts_at=starts_at + INTERVAL '1 minute',version=version+1 WHERE id=?`, eventID)
				return err
			},
		},
		{
			name:      "member_removed",
			lockQuery: "UPDATE server_members SET server_id=server_id",
			prepareWriter: func(ctx context.Context, tx *sql.Tx, eventID string) error {
				_, err := tx.ExecContext(ctx, `DELETE FROM server_members WHERE server_id='event-server' AND user_id=?`, dmBob)
				return err
			},
		},
		{
			name:      "rsvp_withdrawn",
			lockQuery: "UPDATE server_event_rsvps SET user_id=user_id",
			prepareWriter: func(ctx context.Context, tx *sql.Tx, eventID string) error {
				_, err := tx.ExecContext(ctx, `DELETE FROM server_event_rsvps WHERE event_id=? AND user_id=?`, eventID, dmBob)
				return err
			},
		},
		{
			name: "preference_disabled",
			// This fixture creates the preference row in the held transaction;
			// Deliver blocks on the unique-conflict INSERT before reaching its
			// no-op UPDATE lock.
			lockQuery: "INSERT INTO user_preferences",
			prepareWriter: func(ctx context.Context, tx *sql.Tx, _ string) error {
				if _, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}') ON CONFLICT(user_id) DO NOTHING`, dmBob); err != nil {
					return err
				}
				_, err := tx.ExecContext(ctx, `UPDATE user_preferences SET data=? WHERE user_id=?`, `{"notifications":{"upcomingEventNotifications":false}}`, dmBob)
				return err
			},
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			db := newTestDB(t)
			seedEventServer(t, db)
			events := NewSQLiteServerEventRepo(wrapForRepo(db))
			delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			now := time.Now().UTC().Truncate(time.Second)
			event := makeDeliverableEvent(t, ctx, events, "Eligibility lock", now.Add(5*time.Minute))
			tx, err := db.Conn.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			if err := scenario.prepareWriter(ctx, tx, event.ID); err != nil {
				t.Fatal(err)
			}

			type deliveryResult struct {
				notification *models.Notification
				err          error
			}
			done := make(chan deliveryResult, 1)
			go func() {
				notification, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
				done <- deliveryResult{notification: notification, err: err}
			}()

			// Observe PostgreSQL's lock wait for the exact eligibility row. This
			// establishes ordering without guessing from a sleep before release.
			for {
				var waiting bool
				if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(
					SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
					AND state='active' AND wait_event_type='Lock' AND query LIKE ?
				)`, "%"+scenario.lockQuery+"%").Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case result := <-done:
					t.Fatalf("delivery did not wait on %s row: notification=%+v err=%v", scenario.name, result.notification, result.err)
				case <-ctx.Done():
					t.Fatalf("delivery never waited on %s row: %v", scenario.name, ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-done:
				if result.err != nil || result.notification != nil {
					t.Fatalf("delivery ignored committed %s: notification=%+v err=%v", scenario.name, result.notification, result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind='system'`, dmBob); n != 0 {
				t.Fatalf("notification created after committed %s: %d", scenario.name, n)
			}
		})
	}
}

func TestServerEventDeliveryPreferenceMissingUsesEnabledDefault(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Default pref", now.Add(5*time.Minute))
	n, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now)
	if err != nil || n == nil {
		t.Fatalf("default preference delivery = %+v, %v", n, err)
	}
}

func TestServerEventDeliveryPageExcludesRemovedAndAlreadyDeliveredRSVPs(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	events := NewSQLiteServerEventRepo(wrapForRepo(db))
	delivery := NewSQLiteServerEventDeliveryRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	event := makeDeliverableEvent(t, ctx, events, "Recipients", now.Add(5*time.Minute))
	page, err := delivery.InterestedPage(ctx, event.ID, "", 10)
	if err != nil || len(page) != 1 || page[0] != dmBob {
		t.Fatalf("initial interested page = %v, %v", page, err)
	}
	if _, err := delivery.Deliver(ctx, event.ID, event.Version, dmBob, now); err != nil {
		t.Fatal(err)
	}
	page, err = delivery.InterestedPage(ctx, event.ID, "", 10)
	if err != nil || len(page) != 0 {
		t.Fatalf("page after delivery = %v, %v", page, err)
	}
	if _, err := db.Conn.Exec(`DELETE FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob); err != nil {
		t.Fatal(err)
	}
	page, err = delivery.InterestedPage(ctx, event.ID, "", 10)
	if err != nil || len(page) != 0 {
		t.Fatalf("page after member removal = %v, %v", page, err)
	}
}

func TestServerEventDeliveryPageClampsAndReturnsEmpty(t *testing.T) {
	db := newTestDB(t)
	delivery := NewSQLiteServerEventDeliveryRepo(db.Conn)
	page, err := delivery.InterestedPage(context.Background(), "missing", "", 1000)
	if err != nil || len(page) != 0 {
		t.Fatalf("empty page = %v, %v", page, err)
	}
	if _, err := delivery.DueCandidates(context.Background(), time.Now(), 1000, ""); err != nil {
		t.Fatal(fmt.Errorf("DueCandidates: %w", err))
	}
}
