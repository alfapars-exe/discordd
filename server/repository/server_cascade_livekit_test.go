package repository

import (
	"context"
	"testing"
)

func TestServerDeletionReleasesAssignedMedia(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed,server_count)
			VALUES('private','local','fixture','fixture',0,1),('managed','local','fixture','fixture',1,2)`, nil},
		{`INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES
			('one','One',?,'private'),('two','Two',?,'managed'),('three','Three',?,'managed')`, []any{dmAlice, dmBob, dmCarol}},
	})
	repo := NewSQLiteServerRepo(db.Conn)
	execSeed(t, db, []seedStmt{
		{`CREATE TABLE media_cleanup_guard(instance_id TEXT REFERENCES livekit_instances(id))`, nil},
		{`INSERT INTO media_cleanup_guard(instance_id) VALUES('private')`, nil},
	})
	if err := repo.Delete(context.Background(), "one"); err == nil {
		t.Fatal("expected media cleanup failure")
	}
	if _, err := repo.GetByID(context.Background(), "one"); err != nil {
		t.Fatalf("server deletion escaped rollback: %v", err)
	}
	if _, err := db.Conn.Exec("DELETE FROM media_cleanup_guard"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		if err := repo.Delete(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	var private, managed int
	if err := db.Conn.QueryRow("SELECT COUNT(*) FROM livekit_instances WHERE id='private'").Scan(&private); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow("SELECT server_count FROM livekit_instances WHERE id='managed'").Scan(&managed); err != nil {
		t.Fatal(err)
	}
	if private != 0 || managed != 1 {
		t.Fatalf("private rows=%d, managed count=%d", private, managed)
	}
}

func TestConcurrentServerDeletionReleasesLastPrivateMediaReference(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO livekit_instances(id,url,api_key,api_secret) VALUES('shared','local','fixture','fixture')`, nil},
		{`INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES ('one','One',?,'shared'),('two','Two',?,'shared')`, []any{dmAlice, dmBob}},
	})
	repo := NewSQLiteServerRepo(db.Conn)
	done := make(chan error, 2)
	for _, id := range []string{"one", "two"} {
		go func() { done <- repo.Delete(context.Background(), id) }()
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
	var count int
	if err := db.Conn.QueryRow("SELECT COUNT(*) FROM livekit_instances WHERE id='shared'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining shared instance rows=%d, err=%v", count, err)
	}
}
