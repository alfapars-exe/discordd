package repository

import (
	"context"
	"fmt"
	"testing"
)

func TestAccountDeletionStatusFreshOwnershipPaginationAndIsolation(t *testing.T) {
	db, _, _ := authSessionRepoFixture(t)
	ctx := context.Background()
	r := NewSQLiteAccountDeletionStatusRepo(wrapForRepo(db))
	for i := 0; i < 55; i++ {
		if _, err := db.Conn.Exec(`INSERT INTO servers(id,name,owner_id) VALUES(?,?,?)`, fmt.Sprintf("owned-%02d", i), fmt.Sprintf("Owned %d", i), "session-user"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('owned-app','ownedapp','!disabled!',1,'session-user')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO servers(id,name,owner_id) VALUES('foreign','Foreign','session-other')`); err != nil {
		t.Fatal(err)
	}
	first, err := r.Get(ctx, "session-user", 0)
	if err != nil || first.OwnedCount != 56 || len(first.Resources) != 50 || first.NextOffset == nil || *first.NextOffset != 50 || first.Resources[0].Kind != "application" {
		t.Fatalf("first %+v %v", first, err)
	}
	second, err := r.Get(ctx, "session-user", 50)
	if err != nil || second.OwnedCount != 56 || len(second.Resources) != 6 || second.NextOffset != nil {
		t.Fatalf("second %+v %v", second, err)
	}
	foreign, err := r.Get(ctx, "session-other", 0)
	if err != nil || foreign.OwnedCount != 1 || len(foreign.Resources) != 1 || foreign.Resources[0].ID != "foreign" {
		t.Fatalf("isolation %+v %v", foreign, err)
	}
	if _, err := db.Conn.Exec(`UPDATE servers SET owner_id='session-other' WHERE id='owned-00'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_admin=1 WHERE id='session-user'`); err != nil {
		t.Fatal(err)
	}
	changed, err := r.Get(ctx, "session-user", 0)
	if err != nil || changed.OwnedCount != 55 || !changed.PlatformAdmin {
		t.Fatalf("stale assessment %+v %v", changed, err)
	}
	empty, err := r.Get(ctx, "session-user", 1000)
	if err != nil || empty.OwnedCount != 55 || len(empty.Resources) != 0 {
		t.Fatalf("empty page hid blockers %+v %v", empty, err)
	}
	if _, err := r.Get(ctx, "unknown", 0); err == nil {
		t.Fatal("missing account looked safe")
	}
	if _, err := r.Get(ctx, "session-user", -1); err == nil {
		t.Fatal("negative offset accepted")
	}
}
