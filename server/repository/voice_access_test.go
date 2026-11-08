package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"os"
	"testing"
)

func TestPostgresVoiceAdmissionAndAudience(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	d := newTestDB(t)
	execSeed(t, d, []seedStmt{
		{q: "INSERT INTO users(id,username,password_hash) VALUES('viewer','viewer','x'),('other','other','x')"},
		{q: "INSERT INTO servers(id,name,owner_id) VALUES('guild','guild','viewer')"},
		{q: "INSERT INTO server_members(server_id,user_id) VALUES('guild','viewer')"},
		{q: "INSERT INTO channels(id,server_id,name,type) VALUES('room','guild','room','voice')"},
		{q: "INSERT INTO roles(id,server_id,name,permissions) VALUES('role','guild','role',4160)"},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) VALUES('viewer','role','guild')"},
	})
	ctx := context.Background()
	repo := NewSQLiteChannelRepo(wrapForRepo(d)).(*postgresVoiceChannelRepo)
	check := func(visible bool) {
		t.Helper()
		a, err := repo.VoiceAdmission(ctx, "viewer", "room")
		if err != nil || !a.Member || !a.Permissions.Has(models.PermConnectVoice) || a.Permissions.Has(models.PermViewChannel) != visible {
			t.Fatalf("admission %v err %v", a, err)
		}
		ids, err := repo.VoiceVisibleUsers(ctx, "guild", "room", []string{"viewer", "other", "viewer"})
		if err != nil || (visible && (len(ids) != 1 || ids[0] != "viewer")) || (!visible && len(ids) != 0) {
			t.Fatalf("audience %v err %v", ids, err)
		}
	}
	check(true)
	execSeed(t, d, []seedStmt{{q: "INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES('room','role',0,4096)"}})
	check(false)
	a, err := repo.VoiceAdmission(ctx, "other", "room")
	if err != nil || a.Member {
		t.Fatalf("nonmember %v err %v", a, err)
	}
}
