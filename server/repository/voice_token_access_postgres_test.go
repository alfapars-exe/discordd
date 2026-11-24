package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// The voice join and the moderator move read their access snapshot with
// VoiceTokenAccess and fall back to VoiceAdmission when the server has no
// LiveKit instance (services.loadVoiceJoin, startMoveReads); the move's
// repeated read (refreshMoveSnapshot) relies on a sanction committed in
// between being visible. The service tests pin all of that against a fake
// reader. These run the real statements.

func seedVoiceTokenAccess(t testing.TB, d *database.DB) {
	t.Helper()
	perms := int64(models.PermViewChannel | models.PermConnectVoice | models.PermSpeak)
	execSeed(t, d, []seedStmt{
		{q: "INSERT INTO users(id,username,password_hash) VALUES('member','member','x'),('stranger','stranger','x')"},
		{q: "INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed,auto_switch_enabled,monthly_quota_minutes,switch_threshold_minutes) VALUES('sfu','wss://sfu.test.invalid','fixture-key','fixture-secret',1,0,4321,17)"},
		{q: "INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES('linked','linked','member','sfu'),('bare','bare','member',NULL)"},
		{q: "INSERT INTO server_members(server_id,user_id) VALUES('linked','member'),('bare','member')"},
		{q: "INSERT INTO channels(id,server_id,name,type,user_limit) VALUES('linked-voice','linked','voice','voice',7),('bare-voice','bare','voice','voice',0),('linked-text','linked','text','text',0)"},
		{q: "INSERT INTO roles(id,server_id,name,permissions) VALUES('linked-role','linked','role',?),('bare-role','bare','role',?)", args: []any{perms, perms}},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) VALUES('member','linked-role','linked'),('member','bare-role','bare')"},
	})
}

func TestPostgresVoiceTokenAccessSnapshot(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	d := newTestDB(t)
	seedVoiceTokenAccess(t, d)
	ctx := context.Background()
	repo := NewSQLiteChannelRepo(wrapForRepo(d)).VoiceAccess()
	if repo == nil {
		t.Fatal("PostgreSQL did not select the snapshot voice access reader")
	}
	now := time.Now().UTC()
	previous := now.AddDate(0, -1, 0)
	execSeed(t, d, []seedStmt{
		{q: "INSERT INTO livekit_monthly_usage(instance_id,year,month,used_seconds) VALUES('sfu',?,?,1234),('sfu',?,?,99999)",
			args: []any{now.Year(), int(now.Month()), previous.Year(), int(previous.Month())}},
	})
	wantPerms := models.PermViewChannel | models.PermConnectVoice | models.PermSpeak

	t.Run("member gets admission, instance and this month's usage", func(t *testing.T) {
		admission, instance, used, err := repo.VoiceTokenAccess(ctx, "member", "linked-voice", now)
		if err != nil {
			t.Fatal(err)
		}
		if admission.Channel.ID != "linked-voice" || admission.Channel.ServerID != "linked" || admission.Channel.Type != models.ChannelTypeVoice || admission.Channel.UserLimit != 7 {
			t.Fatalf("channel %+v", admission.Channel)
		}
		if !admission.Member || admission.TimedOut || admission.Permissions != wantPerms {
			t.Fatalf("admission member=%v timedOut=%v permissions=%d, want member with %d", admission.Member, admission.TimedOut, admission.Permissions, wantPerms)
		}
		if instance == nil || instance.ID != "sfu" || instance.URL != "wss://sfu.test.invalid" || instance.APIKey != "fixture-key" || instance.APISecret != "fixture-secret" ||
			!instance.IsPlatformManaged || instance.AutoSwitchEnabled || instance.MonthlyQuotaMinutes != 4321 || instance.SwitchThresholdMinutes != 17 {
			t.Fatalf("instance %+v", instance)
		}
		if used != 1234 {
			t.Fatalf("usage %d, want this month's 1234", used)
		}
		// A month without a usage row is zero, not an error and not a
		// neighbouring month's figure.
		if _, _, used, err := repo.VoiceTokenAccess(ctx, "member", "linked-voice", now.AddDate(0, 1, 0)); err != nil || used != 0 {
			t.Fatalf("next month's usage %d err %v", used, err)
		}
		// The plain admission read agrees on everything it carries.
		plain, err := repo.VoiceAdmission(ctx, "member", "linked-voice")
		if err != nil || *plain != *admission {
			t.Fatalf("admission read %+v err %v, token read %+v", plain, err, admission)
		}
	})

	t.Run("non-member is answered, not refused by the read", func(t *testing.T) {
		admission, instance, _, err := repo.VoiceTokenAccess(ctx, "stranger", "linked-voice", now)
		if err != nil {
			t.Fatal(err)
		}
		if admission.Member || admission.Permissions != 0 || instance == nil || instance.ID != "sfu" {
			t.Fatalf("stranger: member=%v permissions=%d instance=%+v", admission.Member, admission.Permissions, instance)
		}
	})

	// loadVoiceJoin and startMoveReads tell "no instance linked" from "no
	// such channel" by repeating the plain admission read after ErrNotFound.
	t.Run("server without an instance", func(t *testing.T) {
		admission, instance, used, err := repo.VoiceTokenAccess(ctx, "member", "bare-voice", now)
		if !errors.Is(err, pkg.ErrNotFound) || admission != nil || instance != nil || used != 0 {
			t.Fatalf("token read on a server without an instance: %+v %+v %d %v, want pkg.ErrNotFound", admission, instance, used, err)
		}
		plain, err := repo.VoiceAdmission(ctx, "member", "bare-voice")
		if err != nil {
			t.Fatalf("admission read on the same channel: %v", err)
		}
		if plain.Channel.ID != "bare-voice" || plain.Channel.ServerID != "bare" || plain.Channel.Type != models.ChannelTypeVoice || !plain.Member || plain.TimedOut || plain.Permissions != wantPerms {
			t.Fatalf("admission on a server without an instance: %+v", plain)
		}
	})

	t.Run("missing channel", func(t *testing.T) {
		if _, _, _, err := repo.VoiceTokenAccess(ctx, "member", "no-such-channel", now); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("token read: %v, want pkg.ErrNotFound", err)
		}
		if _, err := repo.VoiceAdmission(ctx, "member", "no-such-channel"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("admission read: %v, want pkg.ErrNotFound", err)
		}
	})

	t.Run("text channel is reported with its type", func(t *testing.T) {
		admission, _, _, err := repo.VoiceTokenAccess(ctx, "member", "linked-text", now)
		if err != nil || admission.Channel.Type != models.ChannelTypeText {
			t.Fatalf("text channel: %+v err %v", admission, err)
		}
	})

	// The move's repeated access read stands in for the read the moved
	// client's own token request would make: what was committed after the
	// first read has to be in the second.
	t.Run("sanctions committed between two reads", func(t *testing.T) {
		read := func() *models.VoiceAdmission {
			t.Helper()
			admission, instance, _, err := repo.VoiceTokenAccess(ctx, "member", "linked-voice", now)
			if err != nil || instance == nil {
				t.Fatalf("token read: %v", err)
			}
			return admission
		}
		if first := read(); !first.Member || first.TimedOut {
			t.Fatalf("before any sanction: %+v", first)
		}
		execSeed(t, d, []seedStmt{{q: "INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by) VALUES('linked','member',CURRENT_TIMESTAMP + INTERVAL '10 minutes','member')"}})
		if timedOut := read(); !timedOut.TimedOut || !timedOut.Member {
			t.Fatalf("after the timeout was committed: %+v", timedOut)
		}
		// A timeout on another server, and one that has run out, do not count.
		execSeed(t, d, []seedStmt{
			{q: "UPDATE member_timeouts SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE server_id='linked' AND user_id='member'"},
			{q: "INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by) VALUES('bare','member',CURRENT_TIMESTAMP + INTERVAL '10 minutes','member')"},
		})
		if expired := read(); expired.TimedOut {
			t.Fatalf("expired timeout still reported: %+v", expired)
		}
		execSeed(t, d, []seedStmt{{q: "DELETE FROM server_members WHERE server_id='linked' AND user_id='member'"}})
		if removed := read(); removed.Member {
			t.Fatalf("after the membership was removed: %+v", removed)
		}
		// Unlinking the instance turns the next read into the fallback case.
		execSeed(t, d, []seedStmt{{q: "UPDATE servers SET livekit_instance_id=NULL WHERE id='linked'"}})
		if _, _, _, err := repo.VoiceTokenAccess(ctx, "member", "linked-voice", now); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("token read after the instance was unlinked: %v", err)
		}
		if plain, err := repo.VoiceAdmission(ctx, "member", "linked-voice"); err != nil || plain.Member {
			t.Fatalf("admission read after the instance was unlinked: %+v err %v", plain, err)
		}
	})
}

// The deferred session-touch writer has one statement. Its guards are
// already pinned on whichever backend the suite runs on
// (TestTouchAuthSessionAppliesOnlyStaleLiveSessions); this one insists on
// PostgreSQL, where the writer runs in production.
func TestPostgresTouchAuthSession(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	db, r, _ := authSessionRepoFixture(t)
	if !database.IsPostgres(db.Conn) {
		t.Fatal("fixture is not PostgreSQL")
	}
	ctx := context.Background()
	q := wrapForRepo(db)
	live, _ := createLogicalSession(t, r, "session-user", "pg-live", "pg-live-refresh")
	revoked, _ := createLogicalSession(t, r, "session-user", "pg-revoked", "pg-revoked-refresh")
	now := time.Now().Unix()
	execSeed(t, db, []seedStmt{{q: "UPDATE auth_sessions SET last_active_at=1 WHERE id IN ('pg-live','pg-revoked')"}})
	if ok, err := r.Revoke(ctx, revoked.UserID, revoked.ID, now); err != nil || !ok {
		t.Fatalf("revoke fixture session: %v %v", ok, err)
	}

	for name, touch := range map[string]AuthSessionTouch{
		"missing session":       {UserID: "session-user", SessionID: "pg-absent", At: now},
		"another user's touch":  {UserID: "session-other", SessionID: live.ID, At: now},
		"revoked session":       {UserID: revoked.UserID, SessionID: revoked.ID, At: now},
		"touch older than rest": {UserID: live.UserID, SessionID: live.ID, At: 30},
	} {
		touched, err := TouchAuthSession(ctx, q, touch)
		if err != nil || touched {
			t.Fatalf("%s: touched=%v err=%v, want a no-op", name, touched, err)
		}
	}
	if at := storedLastActive(t, db, live.ID); at != 1 {
		t.Fatalf("no-op touches moved the live session to %d", at)
	}
	if at := storedLastActive(t, db, revoked.ID); at != 1 {
		t.Fatalf("revoked session moved to %d", at)
	}

	touched, err := TouchAuthSession(ctx, q, AuthSessionTouch{UserID: live.UserID, SessionID: live.ID, At: now})
	if err != nil || !touched {
		t.Fatalf("live session: touched=%v err=%v", touched, err)
	}
	if at := storedLastActive(t, db, live.ID); at != now {
		t.Fatalf("live session last_active_at=%d, want %d", at, now)
	}
	// A late deferred touch never moves the timestamp backwards, and a
	// repeated one is not a second write.
	for _, at := range []int64{now - 3600, now, now + 59} {
		touched, err := TouchAuthSession(ctx, q, AuthSessionTouch{UserID: live.UserID, SessionID: live.ID, At: at})
		if err != nil || touched || storedLastActive(t, db, live.ID) != now {
			t.Fatalf("touch at %d: touched=%v err=%v stored=%d", at, touched, err, storedLastActive(t, db, live.ID))
		}
	}
	// A cancelled context reaches the statement: the writer's stop relies on
	// it to abandon an in-flight touch.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if touched, err := TouchAuthSession(cancelled, q, AuthSessionTouch{UserID: live.UserID, SessionID: live.ID, At: now + 7200}); err == nil || touched {
		t.Fatalf("touch on a cancelled context: touched=%v err=%v", touched, err)
	}
	if at := storedLastActive(t, db, live.ID); at != now {
		t.Fatalf("cancelled touch wrote %d", at)
	}
}
