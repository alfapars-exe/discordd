package repository

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestServerOwnershipTransferAtomicRolesAndOneWinner(t *testing.T) {
	for _, foreignKeys := range []bool{true, false} {
		t.Run(fmt.Sprintf("foreign_keys_%v", foreignKeys), func(t *testing.T) {
			db, sessions, _ := authSessionRepoFixture(t)
			if !foreignKeys {
				disableFixtureForeignKeys(t, db)
			}
			actor, _ := createLogicalSession(t, sessions, "session-user", "transfer-actor", "transfer-refresh")
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO servers(id,name,owner_id) VALUES('handoff','Handoff','session-user')`},
				{q: `INSERT INTO server_members(server_id,user_id) VALUES('handoff','session-user'),('handoff','session-other')`},
				{q: `INSERT INTO roles(id,server_id,name,is_owner,permissions) VALUES('handoff-owner','handoff','Owner',1,512),('handoff-regular','handoff','Member',0,32)`},
				{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES('session-user','handoff-owner','handoff'),('session-user','handoff-regular','handoff'),('session-other','handoff-regular','handoff')`},
			})
			r := NewSQLiteServerOwnershipRepo(wrapForRepo(db))
			ctx := context.Background()
			now := time.Now().Unix()
			if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "wrong", "", "handoff", "session-other", now); err == nil {
				t.Fatal("wrong password proof accepted")
			}
			if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "stale-factor", "handoff", "session-other", now); err == nil {
				t.Fatal("stale factor accepted")
			}
			installWriteFailure(t, db, "deny_owner_grant", "user_roles", "INSERT", "NEW.role_id='handoff-owner'")
			if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", now); err == nil {
				t.Fatal("partial role change succeeded")
			}
			var owner string
			if err := db.Conn.QueryRow(`SELECT owner_id FROM servers WHERE id='handoff'`).Scan(&owner); err != nil || owner != actor.UserID {
				t.Fatal("failed transfer changed owner", owner, err)
			}
			dropFailureTrigger(t, db, "deny_owner_grant", "user_roles")
			installWriteFailure(t, db, "deny_transfer_audit", "audit_logs", "INSERT", "")
			if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", now); err == nil {
				t.Fatal("unaudited ownership committed")
			}
			if err := db.Conn.QueryRow(`SELECT owner_id FROM servers WHERE id='handoff'`).Scan(&owner); err != nil || owner != actor.UserID {
				t.Fatal("failed audit changed owner", owner, err)
			}
			dropFailureTrigger(t, db, "deny_transfer_audit", "audit_logs")
			var winners atomic.Int32
			var wg sync.WaitGroup
			for i := 0; i < 12; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", now); err == nil {
						winners.Add(1)
					}
				}()
			}
			wg.Wait()
			if winners.Load() != 1 {
				t.Fatalf("winners=%d", winners.Load())
			}
			auditQuery := `SELECT COUNT(*) FROM audit_logs WHERE server_id='handoff' AND json_extract(actor_snapshot,'$.id')='session-user' AND json_extract(target_snapshot,'$.id')='session-other'`
			if database.IsPostgres(db.Conn) {
				auditQuery = `SELECT COUNT(*) FROM audit_logs WHERE server_id='handoff' AND actor_snapshot::jsonb->>'id'='session-user' AND target_snapshot::jsonb->>'id'='session-other'`
			}
			for query, want := range map[string]int{
				auditQuery: 1,
				`SELECT COUNT(*) FROM user_roles WHERE role_id='handoff-owner' AND user_id='session-other'`:            1,
				`SELECT COUNT(*) FROM user_roles WHERE role_id='handoff-owner' AND user_id='session-user'`:             0,
				`SELECT COUNT(*) FROM user_roles WHERE role_id='handoff-regular'`:                                      2,
				`SELECT COUNT(*) FROM server_members WHERE server_id='handoff'`:                                        2,
				`SELECT COUNT(*) FROM audit_logs WHERE server_id='handoff' AND event_type='server_ownership_transfer'`: 1,
			} {
				var got int
				if err := db.Conn.QueryRow(query).Scan(&got); err != nil || got != want {
					t.Fatal(query, got, want, err)
				}
			}
		})
	}
}

func TestServerOwnershipTransferRejectsIneligibleTargetAndAdministrativeOverride(t *testing.T) {
	for _, tt := range []struct {
		name, change string
		actorOther   bool
	}{
		{name: "nonmember", change: `DELETE FROM server_members WHERE user_id='session-other'`},
		{name: "bot", change: `UPDATE users SET is_bot=1 WHERE id='session-other'`},
		{name: "platform banned", change: `UPDATE users SET is_platform_banned=1 WHERE id='session-other'`},
		{name: "deleted", change: `UPDATE users SET deleted_at=1 WHERE id='session-other'`},
		{name: "disabled", change: `INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES('session-other',1,1)`},
		{name: "server banned", change: `INSERT INTO bans(server_id,user_id,reason) VALUES('handoff','session-other','fixture')`},
		{name: "missing owner role", change: `DELETE FROM roles WHERE id='handoff-owner'`},
		{name: "ambiguous owner role", change: `INSERT INTO roles(id,name,server_id,is_owner) VALUES('extra-owner','Extra','handoff',1)`},
		{name: "revoked session", change: `UPDATE auth_sessions SET revoked_at=1 WHERE user_id='session-user'`},
		{name: "platform admin not owner", change: `UPDATE users SET is_platform_admin=1 WHERE id='session-other'`, actorOther: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			db, sessions, _ := authSessionRepoFixture(t)
			ownerSession, _ := createLogicalSession(t, sessions, "session-user", "owner-action", "owner-refresh")
			otherSession, _ := createLogicalSession(t, sessions, "session-other", "other-action", "other-refresh")
			execSeed(t, db, []seedStmt{{q: `INSERT INTO servers(id,name,owner_id) VALUES('handoff','Handoff','session-user')`}, {q: `INSERT INTO server_members(server_id,user_id) VALUES('handoff','session-user'),('handoff','session-other')`}, {q: `INSERT INTO roles(id,server_id,name,is_owner) VALUES('handoff-owner','handoff','Owner',1)`}, {q: tt.change}})
			actor, sid, target := "session-user", ownerSession.ID, "session-other"
			if tt.actorOther {
				actor, sid, target = "session-other", otherSession.ID, "session-user"
			}
			if _, err := NewSQLiteServerOwnershipRepo(wrapForRepo(db)).Transfer(context.Background(), actor, sid, "hash", "", "handoff", target, time.Now().Unix()); err == nil {
				t.Fatal("ineligible transfer accepted")
			}
			var owner string
			if err := db.Conn.QueryRow(`SELECT owner_id FROM servers WHERE id='handoff'`).Scan(&owner); err != nil || owner != "session-user" {
				t.Fatal("rejection changed owner", owner, err)
			}
		})
	}
}

func TestServerOwnershipTransferPreservesManagedHostingQuota(t *testing.T) {
	db, sessions, _ := authSessionRepoFixture(t)
	actor, _ := createLogicalSession(t, sessions, "session-user", "quota-action", "quota-refresh")
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed) VALUES('managed-fixture','wss://fixture.invalid','fixture-key','fixture-secret',1)`},
		{q: `INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES('handoff','Handoff','session-user','managed-fixture'),('already-owned','Other','session-other','managed-fixture')`},
		{q: `INSERT INTO server_members(server_id,user_id) VALUES('handoff','session-user'),('handoff','session-other')`},
		{q: `INSERT INTO roles(id,server_id,name,is_owner) VALUES('handoff-owner','handoff','Owner',1)`},
	})
	r := NewSQLiteServerOwnershipRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", now); err == nil {
		t.Fatal("transfer bypassed hosted-server quota")
	}
	// Mirror the existing server-creation policy's platform-admin exemption.
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_admin=1 WHERE id='session-other'`); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Transfer(ctx, actor.UserID, actor.ID, "hash", "", "handoff", "session-other", now); err != nil {
		t.Fatal("existing quota exemption not preserved", err)
	}
}
