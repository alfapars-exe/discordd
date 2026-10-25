package repository

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

func TestApplicationRemovalPreservesHistoryAndDetachesOwnership(t *testing.T) {
	for _, fk := range []bool{true, false} {
		t.Run(fmt.Sprintf("foreign_keys_%v", fk), func(t *testing.T) {
			db, sessions, _ := authSessionRepoFixture(t)
			if !fk {
				disableFixtureForeignKeys(t, db)
			}
			actor, _ := createLogicalSession(t, sessions, "session-user", "app-removal-actor", "app-removal-refresh")
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id,avatar_url) VALUES('app','application','!disabled!',1,'session-user','/api/uploads/avatars/app.png')`},
				{q: `INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('app-token','app','old-app-token-hash')`},
				{q: `INSERT INTO servers(id,name,owner_id) VALUES('app-server','Shared server','session-other')`},
				{q: `INSERT INTO server_members(server_id,user_id) VALUES('app-server','app'),('app-server','session-other')`},
				{q: `INSERT INTO channels(id,name,type,server_id) VALUES('app-channel','shared','text','app-server')`},
				{q: `INSERT INTO messages(id,channel_id,user_id,content) VALUES('app-message','app-channel','app','opaque-ciphertext')`},
				{q: `INSERT INTO attachments(id,message_id,filename,file_url) VALUES('app-attachment','app-message','file.bin','/api/uploads/attachments/app-shared.bin')`},
				{q: `INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('app-dm','app','session-other')`},
				{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('app-dm-message','app-dm','app','opaque-dm')`},
			})
			r := NewSQLiteApplicationRemovalRepo(wrapForRepo(db))
			ctx := context.Background()
			now := time.Now().Unix()
			if err := r.Remove(ctx, actor.UserID, actor.ID, "wrong", "", "app", now); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatal("wrong password proof accepted", err)
			}
			if err := r.Remove(ctx, actor.UserID, actor.ID, "hash", "changed-factor", "app", now); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatal("stale factor proof accepted", err)
			}
			installWriteFailure(t, db, "reject_app_retirement", "users", "UPDATE OF deleted_at", "NEW.id='app'")
			if err := r.Remove(ctx, actor.UserID, actor.ID, "hash", "", "app", now); err == nil {
				t.Fatal("partial retirement succeeded")
			}
			var tokens int
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM bot_tokens WHERE bot_user_id='app'`).Scan(&tokens); err != nil || tokens != 1 {
				t.Fatal("failed retirement revoked token", tokens, err)
			}
			dropFailureTrigger(t, db, "reject_app_retirement", "users")
			var winners atomic.Int32
			var wg sync.WaitGroup
			for i := 0; i < 12; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if r.Remove(ctx, actor.UserID, actor.ID, "hash", "", "app", now) == nil {
						winners.Add(1)
					}
				}()
			}
			wg.Wait()
			if winners.Load() != 1 {
				t.Fatal("retirement winners", winners.Load())
			}
			for query, want := range map[string]int{
				`SELECT COUNT(*) FROM users WHERE id='app' AND deleted_at IS NOT NULL AND owner_user_id IS NULL AND password_hash='!deleted!' AND display_name='Deleted User'`: 1,
				`SELECT COUNT(*) FROM bot_tokens WHERE bot_user_id='app'`:                                             0,
				`SELECT COUNT(*) FROM server_members WHERE user_id='app'`:                                             0,
				`SELECT COUNT(*) FROM messages WHERE id='app-message' AND content='opaque-ciphertext'`:                1,
				`SELECT COUNT(*) FROM attachments WHERE id='app-attachment'`:                                          1,
				`SELECT COUNT(*) FROM dm_messages WHERE id='app-dm-message' AND content='opaque-dm'`:                  1,
				`SELECT COUNT(*) FROM dm_channels WHERE id='app-dm'`:                                                  1,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/avatars/app.png'`:            1,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/attachments/app-shared.bin'`: 0,
				`SELECT COUNT(*) FROM users WHERE id='session-other' AND deleted_at IS NULL`:                          1,
			} {
				var got int
				if err := db.Conn.QueryRow(query).Scan(&got); err != nil || got != want {
					t.Fatal(query, got, want, err)
				}
			}
			status, err := NewSQLiteAccountDeletionStatusRepo(wrapForRepo(db)).Get(ctx, actor.UserID, 0)
			if err != nil || status.OwnedCount != 0 {
				t.Fatal("retired bot still blocks owner deletion", status, err)
			}
			if _, err := db.Conn.Exec(`INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('late-app-token','app','late-token-hash')`); err == nil {
				t.Fatal("late token issued to retired application")
			}
			if err := NewSQLiteAccountAnonymizationRepo(wrapForRepo(db)).Anonymize(ctx, actor.UserID, actor.ID, "hash", "", now); err != nil {
				t.Fatal("owner cannot delete after retiring bot", err)
			}
		})
	}
}

func TestApplicationRemovalRejectsWrongOwnerPrincipalAndChangedProof(t *testing.T) {
	for _, scenario := range []string{"other owner", "human target", "platform administrator override", "bot administrator", "revoked session", "stale generation", "disabled owner", "banned owner", "owned server", "owned child"} {
		t.Run(scenario, func(t *testing.T) {
			db, sessions, _ := authSessionRepoFixture(t)
			a, _ := createLogicalSession(t, sessions, "session-user", "remove-proof", "remove-refresh")
			execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('app','application','!disabled!',1,'session-user')`}, {q: `INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('token','app','proof-hash')`}})
			query := ""
			switch scenario {
			case "other owner":
				query = `UPDATE users SET owner_user_id='session-other' WHERE id='app'`
			case "human target":
				query = `UPDATE users SET is_bot=0 WHERE id='app'`
			case "platform administrator override":
				query = `UPDATE users SET owner_user_id='session-other' WHERE id='app'; UPDATE users SET is_platform_admin=1 WHERE id='session-user'`
			case "bot administrator":
				query = `UPDATE users SET is_platform_admin=1 WHERE id='app'`
			case "revoked session":
				query = `UPDATE auth_sessions SET revoked_at=1 WHERE id='remove-proof'`
			case "stale generation":
				query = `UPDATE users SET token_version=token_version+1 WHERE id='session-user'`
			case "disabled owner":
				query = `INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES('session-user',1,1)`
			case "banned owner":
				query = `UPDATE users SET is_platform_banned=1 WHERE id='session-user'`
			case "owned server":
				query = `INSERT INTO servers(id,name,owner_id) VALUES('app-owned','Owned','app')`
			case "owned child":
				query = `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('child','childapp','!disabled!',1,'app')`
			}
			if _, err := db.Conn.Exec(query); err != nil {
				t.Fatal(err)
			}
			err := NewSQLiteApplicationRemovalRepo(wrapForRepo(db)).Remove(context.Background(), a.UserID, a.ID, "hash", "", "app", time.Now().Unix())
			if err == nil {
				t.Fatal("ineligible removal committed")
			}
			var tokens, deleted int
			if err := db.Conn.QueryRow(`SELECT (SELECT COUNT(*) FROM bot_tokens WHERE bot_user_id='app'),(SELECT COUNT(*) FROM users WHERE id='app' AND deleted_at IS NOT NULL)`).Scan(&tokens, &deleted); err != nil || tokens != 1 || deleted != 0 {
				t.Fatal("failed removal changed bot", tokens, deleted, err)
			}
		})
	}
}
