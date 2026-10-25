package repository

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestGameActivityMembershipSnapshotIsAdditiveAndLegacyFailsClosed(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteServerRepo(db.Conn)
	snapshotRepo, ok := repo.(GameActivityMembershipSnapshotRepository)
	if !ok {
		t.Fatal("server repo missing game activity snapshot capability")
	}
	user := newTestUser("activity-snapshot-user")
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	server := &models.Server{Name: "activity-snapshot-server", OwnerID: user.ID}
	if err := repo.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	if err := repo.AddMember(ctx, server.ID, user.ID); err != nil {
		t.Fatal(err)
	}
	legacy, err := snapshotRepo.GetMemberGameActivityAudience(ctx, server.ID, user.ID)
	if err != nil || legacy != nil {
		t.Fatalf("legacy snapshot = %v, %v; want NULL, nil", legacy, err)
	}
	other := newTestUser("activity-snapshot-user-2")
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, other); err != nil {
		t.Fatal(err)
	}
	if err := snapshotRepo.AddMemberWithGameActivityAudience(ctx, server.ID, other.ID, true); err != nil {
		t.Fatal(err)
	}
	allowed, err := snapshotRepo.GetMemberGameActivityAudience(ctx, server.ID, other.ID)
	if err != nil || allowed == nil || !*allowed {
		t.Fatalf("allowed snapshot = %v, %v", allowed, err)
	}
	servers, err := repo.GetUserServers(ctx, other.ID)
	if err != nil || len(servers) != 1 || !servers[0].GameActivityAudience {
		t.Fatalf("own server projection = %#v, %v; want activity audience true", servers, err)
	}
}

func TestGameActivityMembershipSnapshotSerializesSmallAudienceBoundary(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteServerRepo(db.Conn)
	snapshotRepo := repo.(GameActivityMembershipSnapshotRepository)
	owner := newTestUser("activity-boundary-owner")
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, owner); err != nil {
		t.Fatal(err)
	}
	server := &models.Server{Name: "activity-boundary-server", OwnerID: owner.ID}
	if err := repo.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	if err := snapshotRepo.AddMemberWithGameActivityAudience(ctx, server.ID, owner.ID, true); err != nil {
		t.Fatal(err)
	}
	// Start at 199 members: exactly one of two serialized joins may receive
	// the small-server snapshot (the resulting server size must not exceed 200).
	for i := 0; i < 198; i++ {
		user := newTestUser(fmt.Sprintf("activity-boundary-seed-%03d", i))
		if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
			t.Fatal(err)
		}
		if err := repo.AddMember(ctx, server.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		allowed bool
		err     error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		user := newTestUser(fmt.Sprintf("activity-boundary-join-%d", i))
		if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(userID string) {
			defer wg.Done()
			<-start
			var allowed bool
			err := NewServerMembershipTxRunner(db.Conn).InTx(ctx, func(r *ServerMembershipTxRepos) error {
				counter := r.Server.(interface {
					LockAndCountMembersForGameActivityJoin(context.Context, string) (int, error)
				})
				count, err := counter.LockAndCountMembersForGameActivityJoin(ctx, server.ID)
				if err != nil {
					return err
				}
				allowed = count < 200
				return r.Server.(interface {
					AddMemberWithGameActivityAudience(context.Context, string, string, bool) error
				}).AddMemberWithGameActivityAudience(ctx, server.ID, userID, allowed)
			})
			results <- result{allowed: allowed, err: err}
		}(user.ID)
	}
	close(start)
	wg.Wait()
	close(results)
	allowedCount := 0
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent membership transaction: %v", result.err)
		}
		if result.allowed {
			allowedCount++
		}
	}
	if allowedCount != 1 {
		t.Fatalf("small-audience snapshots allowed=%d, want exactly 1", allowedCount)
	}
	if count, err := repo.GetMemberCount(ctx, server.ID); err != nil || count != 201 {
		t.Fatalf("member count=%d, err=%v; want 201 after two joins", count, err)
	}
}

func TestGameActivityMembershipSnapshotSerializesMixedAudienceBoundary(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteServerRepo(db.Conn)
	snapshotRepo := repo.(GameActivityMembershipSnapshotRepository)
	owner := newTestUser("activity-mixed-owner")
	if err := NewSQLiteUserRepo(db.Conn).Create(ctx, owner); err != nil {
		t.Fatal(err)
	}
	server := &models.Server{Name: "activity-mixed-server", OwnerID: owner.ID}
	if err := repo.Create(ctx, server); err != nil {
		t.Fatal(err)
	}
	if err := snapshotRepo.AddMemberWithGameActivityAudience(ctx, server.ID, owner.ID, true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 198; i++ {
		user := newTestUser(fmt.Sprintf("activity-mixed-seed-%03d", i))
		if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
			t.Fatal(err)
		}
		if err := repo.AddMember(ctx, server.ID, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		audience string
		allowed  bool
		count    int
		err      error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, join := range []struct {
		name     string
		audience string
	}{
		{name: "activity-mixed-all", audience: "all"},
		{name: "activity-mixed-small", audience: "small"},
	} {
		user := newTestUser(join.name)
		if err := NewSQLiteUserRepo(db.Conn).Create(ctx, user); err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(userID, audience string) {
			defer wg.Done()
			<-start
			var count int
			allowed := audience == "all"
			err := NewServerMembershipTxRunner(db.Conn).InTx(ctx, func(r *ServerMembershipTxRepos) error {
				counter := r.Server.(interface {
					LockAndCountMembersForGameActivityJoin(context.Context, string) (int, error)
				})
				var err error
				count, err = counter.LockAndCountMembersForGameActivityJoin(ctx, server.ID)
				if err != nil {
					return err
				}
				if audience == "small" {
					allowed = count < 200
				}
				return r.Server.(interface {
					AddMemberWithGameActivityAudience(context.Context, string, string, bool) error
				}).AddMemberWithGameActivityAudience(ctx, server.ID, userID, allowed)
			})
			results <- result{audience: audience, allowed: allowed, count: count, err: err}
		}(user.ID, join.audience)
	}
	close(start)
	wg.Wait()
	close(results)
	smallSeen := false
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent %s membership transaction: %v", result.audience, result.err)
		}
		if result.audience == "small" {
			smallSeen = true
			if result.allowed != (result.count < 200) {
				t.Fatalf("small join observed count=%d, allowed=%t", result.count, result.allowed)
			}
			if result.count != 199 && result.count != 200 {
				t.Fatalf("small join observed non-serialized count %d; want 199 or 200", result.count)
			}
		} else if !result.allowed {
			t.Fatal("all audience join unexpectedly denied")
		}
	}
	if !smallSeen {
		t.Fatal("small audience result missing")
	}
	if count, err := repo.GetMemberCount(ctx, server.ID); err != nil || count != 201 {
		t.Fatalf("member count=%d, err=%v; want 201 after mixed joins", count, err)
	}
}
