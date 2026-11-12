package repository

import (
	"context"
	"reflect"
	"testing"

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
