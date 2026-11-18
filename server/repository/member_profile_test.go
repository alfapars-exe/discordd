package repository

import (
	"context"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestServerMemberProfilesScopeAndParity(t *testing.T) {
	db := newTestDB(t)
	seedEventServer(t, db)
	execSeed(t, db, []seedStmt{
		{`UPDATE users SET bio='profile', pronouns='they', display_name='A', pref_status='offline',
			last_seen_at=CURRENT_TIMESTAMP WHERE id=?`, []any{dmAlice}},
	})
	ctx := context.Background()
	repo := NewSQLiteUserRepo(db.Conn)
	profiles, err := repo.ListServerMemberProfiles(ctx, "event-server")
	if err != nil || len(profiles) != 2 {
		t.Fatalf("member profiles: count %d, %v", len(profiles), err)
	}
	for i, id := range []string{dmAlice, dmBob} {
		user, err := repo.GetByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		got := models.ToMemberWithRoles(&profiles[i], nil)
		want := models.ToMemberWithRoles(user, nil)
		if !reflect.DeepEqual(got, want) || profiles[i].PasswordHash != "" {
			t.Errorf("member %s projection or credential exclusion differs", id)
		}
	}
	empty, err := repo.ListServerMemberProfiles(ctx, "absent-server")
	if err != nil || len(empty) != 0 {
		t.Fatalf("absent server: count %d, %v", len(empty), err)
	}
}

func TestGroupPublicProfileParity(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteUserRepo(db.Conn)
	ctx := context.Background()
	ids := []string{dmAlice, dmBob, dmAlice, "missing"}
	found, err := repo.PublicUsersByID(ctx, ids)
	if err != nil || len(found) != 2 {
		t.Fatalf("found %d profiles, %v", len(found), err)
	}
	for _, id := range ids[:2] {
		u, err := repo.GetByID(ctx, id)
		if err != nil || !reflect.DeepEqual(found[id], models.ToPublicUser(u)) {
			t.Fatalf("inconsistent profile for %s: %v", id, err)
		}
	}
	if os.Getenv("HICHAT_MEASURE_GROUP_PROFILES") != "1" {
		return
	}
	page := make([]string, 100)
	for i := range page {
		page[i] = ids[i%2]
	}
	for _, bulk := range []bool{false, true} {
		samples := make([]time.Duration, 30)
		before := db.Conn.Stats()
		for i := -1; i < len(samples); i++ {
			start := time.Now()
			if bulk {
				rows, err := repo.PublicUsersByID(ctx, page)
				if err != nil || len(rows) != 2 {
					t.Fatalf("bulk load: %d profiles, %v", len(rows), err)
				}
			} else {
				for _, id := range page {
					if _, err := repo.GetByID(ctx, id); err != nil {
						t.Fatal(err)
					}
				}
			}
			if i >= 0 {
				samples[i] = time.Since(start)
			}
		}
		slices.Sort(samples)
		t.Logf("bulk=%t, 100 messages, p95=%v, pool wait=%v", bulk, samples[28], db.Conn.Stats().WaitDuration-before.WaitDuration)
	}
}
