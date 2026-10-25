package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"strings"
	"sync"
	"testing"
)

func TestMediaLabelAtomicVersionConflictsAndRecreation(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewMediaLabelRepository(db.Conn)
	empty := ""
	e := models.MediaLabel{UserID: dmAlice, SourceKind: "dm", ChannelID: "private", MessageID: "versioned", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "ordinary", ExpectedVersion: &empty}
	// Two clients observing absence cannot both create a record.
	for round := 0; round < 2; round++ {
		var workers sync.WaitGroup
		results := make(chan error, 8)
		start := make(chan struct{})
		for i := 0; i < 8; i++ {
			workers.Add(1)
			go func() { defer workers.Done(); <-start; entry := e; results <- repo.Set(ctx, &entry) }()
		}
		close(start)
		workers.Wait()
		close(results)
		accepted := 0
		for err := range results {
			if err == nil {
				accepted++
			} else if !errors.Is(err, pkg.ErrConflict) {
				t.Fatalf("unexpected version error: %v", err)
			}
		}
		if accepted != 1 {
			t.Fatalf("round=%d successful competing writes=%d", round, accepted)
		}
		current, err := repo.Get(ctx, &e)
		if err != nil || current == nil || len(current.Version) != 32 || current.ExpectedVersion != nil {
			t.Fatalf("version read %+v %v", current, err)
		}
		if round == 0 {
			e.ExpectedVersion = &current.Version
			e.Label = "both"
		}
	}
	current, err := repo.Get(ctx, &e)
	if err != nil {
		t.Fatal(err)
	}
	oldVersion := current.Version
	if err := repo.Delete(ctx, &e); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale deletion: %v", err)
	}
	current.ExpectedVersion = &oldVersion
	if err := repo.Delete(ctx, current); err != nil {
		t.Fatal(err)
	}
	e.ExpectedVersion = &empty
	if err := repo.Set(ctx, &e); err != nil {
		t.Fatal(err)
	}
	// Delete/recreate with the same label still invalidates the old token (ABA).
	current.Label = "sexual"
	if err := repo.Set(ctx, current); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("ABA write accepted: %v", err)
	}
	if err := repo.Delete(ctx, current); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("ABA deletion accepted: %v", err)
	}
	if err := repo.Delete(ctx, &e); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("expected absence deleted a record: %v", err)
	}
	winner, err := repo.Get(ctx, &e)
	if err != nil || winner.Label != "both" || winner.Version == oldVersion {
		t.Fatalf("recreated state %+v %v", winner, err)
	}
}

func TestMediaLabelStorageIsolationRevisionAndRemoval(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewMediaLabelRepository(db.Conn)
	ctx := context.Background()
	e := &models.MediaLabel{UserID: dmAlice, SourceKind: "dm", ChannelID: "private", MessageID: "m", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "sexual"}
	if err := repo.Set(ctx, e); err != nil {
		t.Fatal(err)
	}
	foreign := *e
	foreign.UserID = dmBob
	if found, err := repo.Get(ctx, &foreign); err != nil || found != nil {
		t.Fatalf("foreign read %v %v", found, err)
	}
	if err := repo.Delete(ctx, &foreign); err != nil {
		t.Fatal(err)
	}
	if found, _ := repo.Get(ctx, e); found == nil {
		t.Fatal("foreign deletion removed owner's label")
	}
	stale := *e
	stale.Revision = "2026-10-24T12:00:00Z"
	if found, err := repo.Get(ctx, &stale); err != nil || found != nil {
		t.Fatal("stale revision reused")
	}
	e.Label = "both"
	if err := repo.Set(ctx, e); err != nil {
		t.Fatal(err)
	}
	found, err := repo.Get(ctx, e)
	if err != nil || found.Label != "both" {
		t.Fatal("label update not retained")
	}
	if err := repo.Delete(ctx, e); err != nil {
		t.Fatal(err)
	}
	if found, _ := repo.Get(ctx, e); found != nil {
		t.Fatal("delete failed")
	}
}
func TestMediaLabelQuotaAndDeletedOwner(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewMediaLabelRepository(db.Conn)
	_, err := db.Conn.ExecContext(ctx, `WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4999) INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label) SELECT ?,'dm','private','seed-'||x,'original',?,'ordinary' FROM n`, dmAlice, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	results := make(chan error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			<-start
			results <- repo.Set(ctx, &models.MediaLabel{UserID: dmAlice, SourceKind: "dm", ChannelID: "private", MessageID: fmt.Sprint("race-", i), Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "both"})
		}(i)
	}
	close(start)
	workers.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("quota race successes=%d", success)
	}
	legacy := &models.MediaLabel{UserID: dmAlice, SourceKind: "dm", ChannelID: "private", MessageID: "seed-1", Revision: "original", Fingerprint: strings.Repeat("a", 64)}
	stored, err := repo.Get(ctx, legacy)
	if err != nil || stored.Version != "legacy" {
		t.Fatalf("legacy migration default: %+v %v", stored, err)
	}
	stored.ExpectedVersion = &stored.Version
	stored.Label = "both"
	if err := repo.Set(ctx, stored); err != nil {
		t.Fatalf("versioned existing update at quota: %v", err)
	}
	if err := repo.Set(ctx, stored); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("legacy token reused: %v", err)
	}
	if _, err := db.Conn.ExecContext(ctx, `UPDATE users SET deleted_at=1 WHERE id=?`, dmBob); err != nil {
		t.Fatal(err)
	}
	if err := repo.Set(ctx, &models.MediaLabel{UserID: dmBob, SourceKind: "dm", ChannelID: "private", MessageID: "late", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "both"}); err == nil {
		t.Fatal("deleted owner accepted")
	}
}
