package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func seedEventServer(t *testing.T, db *database.DB) {
	t.Helper()
	seedDMUsers(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO servers(id,name,owner_id) VALUES('event-server','Events',?)`, []any{dmAlice}},
		{`INSERT INTO server_members(server_id,user_id) VALUES('event-server',?),('event-server',?)`, []any{dmAlice, dmBob}},
		{`INSERT INTO channels(id,server_id,name,type) VALUES('event-text','event-server','general','text')`, nil},
	})
}

func eventFixture(name, startsAt string) *models.ServerEvent {
	return &models.ServerEvent{ServerID: "event-server", CreatorID: dmAlice, Name: name, Description: "Community event", StartsAt: startsAt}
}

func TestServerEventRepositoryCRUDCASAndScopedPagination(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(wrapForRepo(db))
	ctx := context.Background()
	base := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	first := eventFixture("First", base.Format(time.RFC3339))
	if err := repo.Create(ctx, first); err != nil {
		t.Fatalf("Create first: %v", err)
	}
	if first.ID == "" || first.Status != models.ServerEventStatusScheduled || first.Version != 1 {
		t.Fatalf("Create defaults not populated: %+v", first)
	}
	assertRFC3339UTC(t, "event starts_at", first.StartsAt)
	foreign, err := repo.GetByID(ctx, "other-server", first.ID)
	if !errors.Is(err, pkg.ErrNotFound) || foreign != nil {
		t.Fatalf("foreign server read = %+v, %v", foreign, err)
	}
	second := eventFixture("Second", base.Add(time.Hour).Format(time.RFC3339))
	if err := repo.Create(ctx, second); err != nil {
		t.Fatalf("Create second: %v", err)
	}
	page, err := repo.List(ctx, "event-server", 1, "")
	if err != nil || len(page) != 1 || page[0].ID != first.ID {
		t.Fatalf("first page = %+v, %v", page, err)
	}
	page, err = repo.List(ctx, "event-server", 10, first.ID)
	if err != nil || len(page) != 1 || page[0].ID != second.ID {
		t.Fatalf("cursor page = %+v, %v", page, err)
	}
	page, err = repo.List(ctx, "event-server", 10, "foreign-cursor")
	if err != nil || len(page) != 0 {
		t.Fatalf("unknown cursor page = %+v, %v; want empty", page, err)
	}

	first.Name = "Updated"
	if ok, err := repo.UpdateCAS(ctx, first, 1); err != nil || !ok {
		t.Fatalf("UpdateCAS = %v, %v", ok, err)
	}
	if first.Version != 2 {
		t.Fatalf("version after update = %d, want 2", first.Version)
	}
	if ok, err := repo.CancelCAS(ctx, "event-server", first.ID, 1); err != nil || ok {
		t.Fatalf("stale CancelCAS = %v, %v; want no change", ok, err)
	}
	if ok, err := repo.CancelCAS(ctx, "event-server", first.ID, 2); err != nil || !ok {
		t.Fatalf("CancelCAS = %v, %v", ok, err)
	}
	if ok, err := repo.UpdateCAS(ctx, first, 2); err != nil || ok {
		t.Fatalf("update after cancel = %v, %v; want no change", ok, err)
	}
	stored, err := repo.GetByID(ctx, "event-server", first.ID)
	if err != nil || stored.Status != models.ServerEventStatusCancelled || stored.Version != 3 {
		t.Fatalf("cancelled event = %+v, %v", stored, err)
	}
}

func TestServerEventRepositoryOrdersFractionalTimesChronologically(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(wrapForRepo(db))
	base := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	whole := eventFixture("Whole second", base.Format(time.RFC3339))
	fractional := eventFixture("Fractional second", base.Add(100*time.Millisecond).Format(time.RFC3339Nano))
	// Insert the later event first to prove order comes from the timestamp,
	// not insertion order or id.
	if err := repo.Create(context.Background(), fractional); err != nil {
		t.Fatalf("Create fractional: %v", err)
	}
	if err := repo.Create(context.Background(), whole); err != nil {
		t.Fatalf("Create whole second: %v", err)
	}
	page, err := repo.List(context.Background(), "event-server", 10, "")
	if err != nil || len(page) != 2 || page[0].ID != whole.ID || page[1].ID != fractional.ID {
		t.Fatalf("chronological page = %+v, %v", page, err)
	}
	end := base.Add(100 * time.Millisecond).Format(time.RFC3339Nano)
	validEnd := eventFixture("Fractional end", base.Format(time.RFC3339))
	validEnd.EndsAt = &end
	if err := repo.Create(context.Background(), validEnd); err != nil {
		t.Fatalf("valid same-second fractional end rejected: %v", err)
	}
}

func TestServerEventRepositoryUpdateCASConcurrentSingleWinner(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(wrapForRepo(db))
	event := eventFixture("Original", time.Now().UTC().Add(24*time.Hour).Truncate(time.Second).Format(time.RFC3339))
	if err := repo.Create(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	type result struct {
		won bool
		err error
	}
	results := make(chan result, 2)
	for _, name := range []string{"Winner A", "Winner B"} {
		candidate := *event
		candidate.Name = name
		go func(copy models.ServerEvent) {
			<-start
			won, err := repo.UpdateCAS(context.Background(), &copy, 1)
			results <- result{won: won, err: err}
		}(candidate)
	}
	close(start)
	winners := 0
	for range 2 {
		got := <-results
		if got.err != nil {
			t.Fatalf("UpdateCAS: %v", got.err)
		}
		if got.won {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("CAS winners = %d, want exactly one", winners)
	}
	stored, err := repo.GetByID(context.Background(), "event-server", event.ID)
	if err != nil || stored.Version != 2 {
		t.Fatalf("stored after concurrent CAS = %+v, %v", stored, err)
	}
}

func TestServerEventRepositoryInterestedRSVPIsIdempotentAndRemovable(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(db.Conn)
	event := eventFixture("RSVP", time.Now().UTC().Add(24*time.Hour).Truncate(time.Second).Format(time.RFC3339))
	if err := repo.Create(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if interested, err := repo.IsInterested(ctx, event.ID, dmBob); err != nil || interested {
		t.Fatalf("initial viewer RSVP state = %v, %v; want false", interested, err)
	}
	if interested, err := repo.IsInterested(ctx, event.ID, dmAlice); err != nil || interested {
		t.Fatalf("another user's RSVP state = %v, %v; want false", interested, err)
	}
	if err := repo.SetInterested(ctx, event.ID, dmBob, true); err != nil {
		t.Fatal(err)
	}
	if interested, err := repo.IsInterested(ctx, event.ID, dmBob); err != nil || !interested {
		t.Fatalf("viewer RSVP state after join = %v, %v; want true", interested, err)
	}
	if interested, err := repo.IsInterested(ctx, event.ID, dmAlice); err != nil || interested {
		t.Fatalf("other user's RSVP state after join = %v, %v; want false", interested, err)
	}
	if err := repo.SetInterested(ctx, event.ID, dmBob, true); err != nil {
		t.Fatal(err)
	}
	ids, err := repo.InterestedUserIDs(ctx, event.ID)
	if err != nil || len(ids) != 1 || ids[0] != dmBob {
		t.Fatalf("interested ids = %v, %v", ids, err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_event_rsvps WHERE event_id=? AND user_id=?`, event.ID, dmBob); n != 1 {
		t.Fatalf("duplicate RSVP count = %d", n)
	}
	if err := repo.SetInterested(ctx, event.ID, dmBob, false); err != nil {
		t.Fatal(err)
	}
	if interested, err := repo.IsInterested(ctx, event.ID, dmBob); err != nil || interested {
		t.Fatalf("viewer RSVP state after withdrawal = %v, %v; want false", interested, err)
	}
	ids, err = repo.InterestedUserIDs(ctx, event.ID)
	if err != nil || len(ids) != 0 {
		t.Fatalf("removed RSVP ids = %v, %v", ids, err)
	}
}

func TestServerEventRSVPRejectsCancelledAndPastButAllowsWithdrawal(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(wrapForRepo(db))
	ctx := context.Background()

	cancelled := eventFixture("Cancelled", time.Now().UTC().Add(time.Hour).Truncate(time.Second).Format(time.RFC3339))
	if err := repo.Create(ctx, cancelled); err != nil {
		t.Fatal(err)
	}
	if ok, err := repo.CancelCAS(ctx, cancelled.ServerID, cancelled.ID, cancelled.Version); err != nil || !ok {
		t.Fatalf("CancelCAS = %v, %v", ok, err)
	}
	if err := repo.SetInterested(ctx, cancelled.ID, dmBob, true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("RSVP to cancelled event = %v, want conflict", err)
	}

	past := eventFixture("Past", time.Now().UTC().Add(-time.Hour).Truncate(time.Second).Format(time.RFC3339))
	if err := repo.Create(ctx, past); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetInterested(ctx, past.ID, dmBob, true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("RSVP to past event = %v, want conflict", err)
	}

	active := eventFixture("Active", time.Now().UTC().Add(time.Hour).Truncate(time.Second).Format(time.RFC3339))
	if err := repo.Create(ctx, active); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetInterested(ctx, active.ID, dmBob, true); err != nil {
		t.Fatalf("active RSVP: %v", err)
	}
	if ok, err := repo.CancelCAS(ctx, active.ServerID, active.ID, active.Version); err != nil || !ok {
		t.Fatalf("CancelCAS active event = %v, %v", ok, err)
	}
	// Withdrawal is deliberately allowed after cancellation so stale client
	// state cannot trap a user's RSVP.
	if err := repo.SetInterested(ctx, active.ID, dmBob, false); err != nil {
		t.Fatalf("withdrawal after cancel: %v", err)
	}
	ids, err := repo.InterestedUserIDs(ctx, active.ID)
	if err != nil || len(ids) != 0 {
		t.Fatalf("RSVPs after withdrawal = %v, %v", ids, err)
	}
}

func TestServerEventRepositoryRejectsInvalidTimes(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(db.Conn)
	event := eventFixture("Invalid", "not-a-time")
	if err := repo.Create(context.Background(), event); err == nil {
		t.Fatal("invalid starts_at accepted")
	}
	event = eventFixture("Invalid end", time.Now().UTC().Add(24*time.Hour).Format(time.RFC3339))
	end := time.Now().UTC().Add(12 * time.Hour).Format(time.RFC3339)
	event.EndsAt = &end
	if err := repo.Create(context.Background(), event); err == nil {
		t.Fatal("ends_at before starts_at accepted")
	}
}

func TestServerEventRSVPRejectsMembershipRemovedBeforeWrite(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(wrapForRepo(db))
	ctx := context.Background()
	event := eventFixture("Membership race", time.Now().UTC().Add(time.Hour).Format(time.RFC3339))
	if err := repo.Create(ctx, event); err != nil {
		t.Fatal(err)
	}
	// Simulate removal after the service's membership check but before its
	// repository write. Foreign keys on users/events alone cannot reject it.
	if _, err := db.Conn.ExecContext(ctx, `DELETE FROM server_members WHERE server_id=? AND user_id=?`, event.ServerID, dmBob); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetInterested(ctx, event.ID, dmBob, true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("RSVP after membership removal = %v, want conflict", err)
	}
	if interested, err := repo.IsInterested(ctx, event.ID, dmBob); err != nil || interested {
		t.Fatalf("removed member RSVP = %v, %v; want absent", interested, err)
	}
}

func TestServerEventMembershipRemovalCleansRSVPAtomically(t *testing.T) {
	for _, failCleanup := range []bool{false, true} {
		t.Run(fmt.Sprintf("cleanup_failure_%t", failCleanup), func(t *testing.T) {
			db := newTestDB(t)
			seedEventServer(t, db)
			ctx := context.Background()
			repo := NewSQLiteServerEventRepo(wrapForRepo(db))
			event := eventFixture("Member cleanup", time.Now().UTC().Add(time.Hour).Format(time.RFC3339))
			if err := repo.Create(ctx, event); err != nil {
				t.Fatal(err)
			}
			for _, user := range []string{dmAlice, dmBob} {
				if err := repo.SetInterested(ctx, event.ID, user, true); err != nil {
					t.Fatal(err)
				}
			}
			if failCleanup {
				installDeleteFailure(t, db, "reject_rsvp_cleanup", "server_event_rsvps")
			}
			err := NewSQLiteServerRepo(wrapForRepo(db)).RemoveMember(ctx, event.ServerID, dmBob)
			if (err != nil) != failCleanup {
				t.Fatalf("RemoveMember = %v", err)
			}
			member, err := NewSQLiteServerRepo(wrapForRepo(db)).IsMember(ctx, event.ServerID, dmBob)
			if err != nil || member != failCleanup {
				t.Fatalf("membership = %v, %v", member, err)
			}
			interested, err := repo.IsInterested(ctx, event.ID, dmBob)
			if err != nil || interested != failCleanup {
				t.Fatalf("removed member RSVP = %v, %v", interested, err)
			}
			interested, err = repo.IsInterested(ctx, event.ID, dmAlice)
			if err != nil || !interested {
				t.Fatalf("other member RSVP = %v, %v", interested, err)
			}
		})
	}
}

func TestServerEventRepositoryRejectsDescriptionOverRuneLimit(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	repo := NewSQLiteServerEventRepo(db.Conn)
	event := eventFixture("Long description", time.Now().UTC().Add(24*time.Hour).Format(time.RFC3339))
	event.Description = strings.Repeat("ş", 2001)
	if err := repo.Create(context.Background(), event); err == nil {
		t.Fatal("description over 2000 Unicode code points accepted")
	}
}

func TestServerEventTimeAPIParsesPostgresTimestampText(t *testing.T) {
	for _, raw := range []string{
		"2026-10-24 10:15:30.123456+00",
		"2026-10-24 10:15:30+00:00",
	} {
		if got := serverEventTimeAPI(raw); got == raw {
			t.Errorf("serverEventTimeAPI(%q) left PostgreSQL timestamp unnormalized", raw)
		} else if _, err := time.Parse(time.RFC3339Nano, got); err != nil {
			t.Errorf("serverEventTimeAPI(%q) = %q: %v", raw, got, err)
		}
	}
}
