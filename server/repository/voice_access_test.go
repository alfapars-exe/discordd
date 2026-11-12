package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"os"
	"testing"
	"time"
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
	// The token path reads routing and quota from the same fresh snapshot.
	execSeed(t, d, []seedStmt{
		{q: "INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed,auto_switch_enabled) VALUES('sfu','wss://test.invalid','fixture-key','fixture-secret',1,1)"},
		{q: "UPDATE servers SET livekit_instance_id='sfu' WHERE id='guild'"},
		{q: "INSERT INTO livekit_monthly_usage(instance_id,year,month,used_seconds) VALUES('sfu',2026,11,987)"},
	})
	for _, month := range []time.Month{time.November, time.December} {
		a, instance, used, err := repo.VoiceTokenAccess(ctx, "viewer", "room", time.Date(2026, month, 1, 0, 0, 0, 0, time.UTC))
		if err != nil {
			t.Fatal(err)
		}
		if !a.Member || !a.Permissions.Has(models.PermConnectVoice) || instance.ID != "sfu" || !instance.IsPlatformManaged || !instance.AutoSwitchEnabled || (month == time.November && used != 987) || (month == time.December && used != 0) {
			t.Fatal("incorrect token admission, routing or usage")
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
