package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"sync"
	"testing"
)

func TestSpamInboxConcurrentQuota(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	_, err := db.Conn.ExecContext(ctx, `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<4999)
 INSERT INTO spam_inbox(user_id,source_kind,channel_id,message_id,revision,reasons)
 SELECT ?, 'dm', 'source', 'seed-' || n, 'original', '["credential-link"]' FROM numbers`, dmBob)
	if err != nil {
		t.Fatal(err)
	}
	repo := NewSpamInboxRepository(db.Conn)
	start := make(chan struct{})
	results := make(chan error, 8)
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			<-start
			results <- repo.Record(ctx, &models.SpamInboxEntry{UserID: dmBob, SourceKind: "dm", ChannelID: "source", MessageID: fmt.Sprintf("racer-%d", i), Revision: "original", Reasons: []string{"credential-link"}})
		}(i)
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("unexpected write failure: %v", err)
		}
	}
	var count int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM spam_inbox WHERE user_id=?`, dmBob).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if successes != 1 || count != models.SpamInboxLimit {
		t.Fatalf("quota race: successes=%d count=%d", successes, count)
	}
}

func TestSpamInboxOwnershipAndRevisionDecisions(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSpamInboxRepository(db.Conn)
	e := &models.SpamInboxEntry{UserID: dmBob, SourceKind: "dm", ChannelID: "private", MessageID: "message", Revision: "original", Reasons: []string{"credential-link"}}
	if err := repo.Record(ctx, e); err != nil {
		t.Fatal(err)
	}
	if ok, err := repo.Decide(ctx, dmAlice, "dm", "message", "original", "restored"); err != nil || ok {
		t.Fatalf("foreign decision: %v %v", ok, err)
	}
	if ok, err := repo.Decide(ctx, dmBob, "dm", "message", "stale", "restored"); err != nil || ok {
		t.Fatalf("stale decision: %v %v", ok, err)
	}
	if ok, err := repo.Decide(ctx, dmBob, "dm", "message", "original", "restored"); err != nil || !ok {
		t.Fatalf("restore: %v %v", ok, err)
	}
	if err := repo.Record(ctx, e); err != nil {
		t.Fatal(err)
	}
	list, err := repo.List(ctx, dmBob, 50)
	if err != nil || len(list) != 0 {
		t.Fatalf("retry resurrected restored message: %v %v", list, err)
	}
	e.Revision = "2026-10-24T12:00:00Z"
	if err := repo.Record(ctx, e); err != nil {
		t.Fatal(err)
	}
	list, err = repo.List(ctx, dmBob, 50)
	if err != nil || len(list) != 1 {
		t.Fatalf("new revision missing: %v %v", list, err)
	}
	foreign, err := repo.List(ctx, dmAlice, 50)
	if err != nil || len(foreign) != 0 {
		t.Fatal("foreign inbox exposed")
	}
	if ok, err := repo.Decide(ctx, dmBob, "dm", "message", e.Revision, "dismissed"); err != nil || !ok {
		t.Fatalf("dismiss: %v %v", ok, err)
	}
	if _, err := repo.Decide(ctx, dmBob, "dm", "message", "edited", "anything"); err == nil {
		t.Fatal("invalid decision accepted")
	}
}

func TestSpamInboxPaginationWithTiedTimestamps(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSpamInboxRepository(db.Conn)
	ctx := context.Background()
	for _, kind := range []string{"channel", "dm", "group"} {
		for i := 0; i < 3; i++ {
			e := &models.SpamInboxEntry{UserID: dmBob, SourceKind: kind, ChannelID: "source", MessageID: fmt.Sprintf("message-%d", i), Revision: "original", Reasons: []string{"credential-link"}}
			if err := repo.Record(ctx, e); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE spam_inbox SET created_at='2026-10-24 12:00:00' WHERE user_id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 5 {
			t.Fatal("pagination did not terminate")
		}
		page, err := repo.Page(ctx, dmBob, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range page.Entries {
			key := entry.SourceKind + ":" + entry.MessageID
			if seen[key] {
				t.Fatalf("duplicate %s", key)
			}
			seen[key] = true
			if entry.UserID != dmBob || entry.Status != "quarantined" {
				t.Fatalf("invalid entry: %+v", entry)
			}
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(seen) != 9 {
		t.Fatalf("lost tied entries: %d", len(seen))
	}
	for _, invalid := range []string{"!", "W10", "bnVsbA"} {
		if _, err := repo.Page(ctx, dmBob, invalid, 2); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("invalid cursor accepted: %q %v", invalid, err)
		}
	}
	if ok, err := repo.Decide(ctx, dmBob, "dm", "message-0", "original", "restored"); err != nil || !ok {
		t.Fatalf("decision: %v %v", ok, err)
	}
	page, err := repo.Decisions(ctx, dmBob, "", 2)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].Status != "restored" {
		t.Fatalf("decision page: %+v %v", page, err)
	}
	foreign, err := repo.Decisions(ctx, dmAlice, "", 2)
	if err != nil || len(foreign.Entries) != 0 {
		t.Fatalf("foreign decisions: %+v %v", foreign, err)
	}
}
