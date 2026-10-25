package database

import (
	"io/fs"
	"testing"
	"testing/fstest"
)

func TestMigration133CancelsOnlyUnboundQueuedFriendshipEmailRows(t *testing.T) {
	db := newRunnerTestDB(t)
	prior := fstest.MapFS{}
	all := fstest.MapFS{}
	entries, err := fs.ReadDir(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	const latest = "133_cancel_unbound_friendship_emails.sql"
	for _, entry := range entries {
		name := entry.Name()
		content, err := fs.ReadFile(EmbeddedMigrations, "migrations/"+name)
		if err != nil {
			t.Fatal(err)
		}
		all[name] = &fstest.MapFile{Data: content}
		if name != latest {
			prior[name] = &fstest.MapFile{Data: content}
		}
	}
	if err := db.runMigrations(prior); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`
		INSERT INTO users(id,username,password_hash,email,email_verified_at) VALUES
		 ('mail-a','mail-a','x','a@example.test',1),('mail-b','mail-b','x','b@example.test',1);
		INSERT INTO friendships(id,user_id,friend_id,status) VALUES('fr-bound','mail-a','mail-b','pending');
		INSERT INTO email_delivery_jobs(id,user_id,category,dedupe_key,subject,body_html,status,claim_token,lease_expires_at,friendship_id,friendship_event) VALUES
		 ('legacy-pending','mail-b','social','friend-request:old-pending','Old','<p>identity</p>','pending',NULL,NULL,NULL,NULL),
		 ('legacy-leased','mail-a','social','friend-accepted:old-leased','Old','<p>identity</p>','delivering','lease-token',CURRENT_TIMESTAMP,NULL,NULL),
		 ('bound','mail-b','social','friend-request:fr-bound','Generic','<p>generic</p>','pending',NULL,NULL,'fr-bound','request'),
		 ('other','mail-b','social','friend-update:old','Other','<p>other</p>','pending',NULL,NULL,NULL,NULL);`); err != nil {
		t.Fatal(err)
	}
	if err := db.runMigrations(all); err != nil {
		t.Fatal(err)
	}
	var status, lastError, claimToken string
	for _, id := range []string{"legacy-pending", "legacy-leased"} {
		if err := db.Conn.QueryRow(`SELECT status,last_error,COALESCE(claim_token,'') FROM email_delivery_jobs WHERE id=?`, id).Scan(&status, &lastError, &claimToken); err != nil {
			t.Fatal(err)
		}
		if status != "cancelled" || lastError != "legacy friendship email retired" || claimToken != "" {
			t.Fatalf("legacy job %s state=(%s,%q,%q)", id, status, lastError, claimToken)
		}
	}
	var retained int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM email_delivery_jobs WHERE id IN ('legacy-pending','legacy-leased')`).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != 2 {
		t.Fatalf("legacy audit rows=%d, want retained rows", retained)
	}
	for id, want := range map[string]string{"bound": "pending", "other": "pending"} {
		if err := db.Conn.QueryRow(`SELECT status FROM email_delivery_jobs WHERE id=?`, id).Scan(&status); err != nil || status != want {
			t.Fatalf("job %s status=%q err=%v, want %s", id, status, err, want)
		}
	}
}
