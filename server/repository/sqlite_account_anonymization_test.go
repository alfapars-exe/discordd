package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
)

func TestSQLiteAccountAnonymizationPreservesSharedHistory(t *testing.T) {
	for _, foreignKeys := range []bool{true, false} {
		t.Run(fmt.Sprintf("foreign_keys_%v", foreignKeys), func(t *testing.T) {
			db, path := newTestDBWithPath(t)
			postgresFKOff := false
			if !foreignKeys {
				if database.IsPostgresDSN(path) {
					// Use an isolated PostgreSQL test schema with FK triggers disabled,
					// matching SQLite's foreign_keys=OFF cleanup-path fixture.
					fkOff := postgresFixtureFKOffConn(t, path)
					fkOff.SetMaxOpenConns(1)
					if err := db.Conn.Close(); err != nil {
						t.Fatal(err)
					}
					db.Conn = fkOff
					postgresFKOff = true
				} else if _, err := db.Conn.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
					t.Fatal(err)
				}
			}
			sessions := NewSQLiteAuthSessionRepo(wrapForRepo(db))
			refresh := NewSQLiteSessionRepo(wrapForRepo(db))
			execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('session-user','sessionuser','hash'),('session-other','sessionother','hash')`}})
			a, old := createLogicalSession(t, sessions, "session-user", "deleting", "old-refresh")
			b, _ := createLogicalSession(t, sessions, "session-other", "surviving", "other-refresh")
			execSeed(t, db, []seedStmt{
				{q: `INSERT INTO servers(id,name,owner_id) VALUES('preserved-server','Shared server','session-other')`},
				{q: `INSERT INTO channels(id,name,type,server_id) VALUES('shared-delete-channel','shared','text','preserved-server')`},
				{q: `UPDATE users SET email='delete@example.invalid',display_name='Original Name',avatar_url='/api/uploads/avatars/personal.png',bio='personal bio' WHERE id='session-user'`},
				{q: `INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('shared-dm','session-other','session-user')`},
				{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('shared-message','shared-dm','session-user','opaque-ciphertext'),('other-message','shared-dm','session-other','other-ciphertext')`},
				{q: `INSERT INTO dm_attachments(id,dm_message_id,filename,file_url) VALUES('shared-file','shared-message','file.bin','/api/uploads/dm/shared.bin')`},
				{q: `INSERT INTO messages(id,channel_id,user_id,content) VALUES('shared-channel-message','shared-delete-channel','session-user','opaque-channel-ciphertext')`},
				{q: `INSERT INTO user_preferences(user_id,data) VALUES('session-user','{}'),('session-other','{}')`},
				{q: `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('cleanup-game','cleanupgame','game-hash',1,'session-other')`},
				{q: `INSERT INTO application_game_identities(bot_user_id) VALUES('cleanup-game')`},
				{q: `INSERT INTO application_game_grants(user_id,bot_user_id,messaging_enabled,revision,authorized_at,updated_at) VALUES('session-user','cleanup-game',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('session-other','cleanup-game',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`},
				{q: `INSERT INTO server_events(id,server_id,creator_id,name,starts_at) VALUES
					('deleted-user-event','preserved-server','session-user','Retained authored event','2026-10-25T12:00:00.000000000Z'),
					('other-user-event','preserved-server','session-other','Other shared event','2026-10-26T12:00:00.000000000Z')`},
				{q: `INSERT INTO server_event_rsvps(event_id,user_id) VALUES
					('deleted-user-event','session-user'),('deleted-user-event','session-other'),
					('other-user-event','session-user'),('other-user-event','session-other')`},
				{q: `INSERT INTO server_event_deliveries(event_id,user_id,starts_at) VALUES
					('deleted-user-event','session-user','2026-10-25T12:00:00.000000000Z'),
					('deleted-user-event','session-other','2026-10-25T12:00:00.000000000Z'),
					('other-user-event','session-user','2026-10-26T12:00:00.000000000Z'),
					('other-user-event','session-other','2026-10-26T12:00:00.000000000Z')`},
				{q: `INSERT INTO email_unsubscribe_tokens(token_hash,user_id,category,email_generation,issued_at,expires_at) VALUES
					(?, 'session-user','social',0,1800000000,1802592000),
					(?, 'session-other','social',0,1800000000,1802592000)`, args: []any{strings.Repeat("a", 64), strings.Repeat("b", 64)}},
				{q: `INSERT INTO user_notes(owner_user_id,target_user_id,note) VALUES('session-user','session-other','private note'),('session-other','session-user','survivor note')`},
				{q: `INSERT INTO channel_sender_key_envelopes(id,channel_id,sender_user_id,sender_device_id,recipient_user_id,recipient_device_id,session_id,message_type,ciphertext) VALUES('sealed','shared-delete-channel','session-user','d1','session-other','d2','s1',1,'sealed-for-survivor')`},
				{q: `INSERT INTO group_dm_channels(id,owner_id,name,key_epoch,call_room_key) VALUES('shared-group','session-user','Shared group',4,'shared-room'),('private-group','session-user','Private group',2,'private-room')`},
				{q: `INSERT INTO group_dm_members(group_id,user_id) VALUES('shared-group','session-user'),('shared-group','session-other'),('private-group','session-user')`},
				{q: `INSERT INTO group_dm_messages(id,group_id,user_id,ciphertext,key_epoch) VALUES('shared-group-message','shared-group','session-user','opaque-group-ciphertext',4),('private-group-message','private-group','session-user','private-ciphertext',2)`},
				{q: `INSERT INTO group_dm_attachments(id,group_message_id,filename,file_url) VALUES('shared-group-file','shared-group-message','shared.bin','/api/uploads/group-dms/shared.bin'),('private-group-file','private-group-message','private.bin','/api/uploads/group-dms/private.bin')`},
				{q: `INSERT INTO group_dm_reactions(id,group_message_id,user_id,emoji) VALUES('deleted-user-reaction','shared-group-message','session-user','ok'),('survivor-reaction','shared-group-message','session-other','keep')`},
				{q: `INSERT INTO group_dm_reads(group_id,user_id,last_read_message_id,unread_count) VALUES('shared-group','session-user','shared-group-message',0),('shared-group','session-other',NULL,1)`},
			})
			r := NewSQLiteAccountAnonymizationRepo(wrapForRepo(db))
			execSeed(t, db, []seedStmt{{q: `INSERT INTO spam_inbox(user_id,source_kind,channel_id,message_id,revision,reasons) VALUES('session-user','dm','shared-dm','spam-own','original','["credential-link"]'),('session-other','dm','shared-dm','spam-other','original','["credential-link"]')`}})
			ctx := context.Background()
			execSeed(t, db, []seedStmt{{q: `INSERT INTO private_media_labels(user_id,source_kind,channel_id,message_id,revision,fingerprint,label) VALUES('session-user','dm','shared-dm','own-label','original',?,'sexual'),('session-other','dm','shared-dm','other-label','original',?,'ordinary')`, args: []any{strings.Repeat("a", 64), strings.Repeat("b", 64)}}})
			now := time.Now().Unix()
			if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); err != nil {
				t.Fatal(err)
			}
			var ownGrants, survivorGrants int
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM application_game_grants WHERE user_id='session-user'`).Scan(&ownGrants); err != nil {
				t.Fatal(err)
			}
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM application_game_grants WHERE user_id='session-other'`).Scan(&survivorGrants); err != nil {
				t.Fatal(err)
			}
			if ownGrants != 0 || survivorGrants != 1 {
				t.Fatalf("game grant cleanup = own:%d survivor:%d", ownGrants, survivorGrants)
			}
			if postgresFKOff {
				// FK-off mode is needed only for the cleanup transaction. Restore
				// normal trigger execution before checking the deleted-state barrier.
				if _, err := db.Conn.Exec(`SET session_replication_role = origin`); err != nil {
					t.Fatal(err)
				}
			}
			var name, display, hash, status string
			var deleted int64
			var personal int
			if err := db.Conn.QueryRow(`SELECT username,display_name,password_hash,status,deleted_at,(email IS NOT NULL OR avatar_url IS NOT NULL OR bio IS NOT NULL) FROM users WHERE id=?`, a.UserID).Scan(&name, &display, &hash, &status, &deleted, &personal); err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(name, "deleted_") || display != "Deleted User" || hash != "!deleted!" || status != "offline" || deleted != now || personal != 0 {
				t.Fatalf("identity not stripped: %s %s %s %d %d", name, display, status, deleted, personal)
			}
			for query, want := range map[string]int{
				`SELECT COUNT(*) FROM private_media_labels WHERE user_id='session-user'`:                                          0,
				`SELECT COUNT(*) FROM private_media_labels WHERE user_id='session-other'`:                                         1,
				`SELECT COUNT(*) FROM spam_inbox WHERE user_id='session-user'`:                                                    0,
				`SELECT COUNT(*) FROM spam_inbox WHERE user_id='session-other'`:                                                   1,
				`SELECT COUNT(*) FROM dm_channels WHERE id='shared-dm'`:                                                           1,
				`SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id='shared-dm'`:                                                2,
				`SELECT COUNT(*) FROM dm_attachments WHERE id='shared-file'`:                                                      1,
				`SELECT COUNT(*) FROM user_preferences WHERE user_id='session-user'`:                                              0,
				`SELECT COUNT(*) FROM user_preferences WHERE user_id='session-other'`:                                             1,
				`SELECT COUNT(*) FROM server_event_rsvps WHERE user_id='session-user'`:                                            0,
				`SELECT COUNT(*) FROM server_event_deliveries WHERE user_id='session-user'`:                                       0,
				`SELECT COUNT(*) FROM email_unsubscribe_tokens WHERE user_id='session-user'`:                                      0,
				`SELECT COUNT(*) FROM email_unsubscribe_tokens WHERE user_id='session-other'`:                                     1,
				`SELECT COUNT(*) FROM server_events WHERE id='deleted-user-event' AND creator_id='session-user'`:                  1,
				`SELECT COUNT(*) FROM server_events WHERE id='other-user-event' AND creator_id='session-other'`:                   1,
				`SELECT COUNT(*) FROM server_event_rsvps WHERE event_id='deleted-user-event' AND user_id='session-other'`:         1,
				`SELECT COUNT(*) FROM server_event_deliveries WHERE event_id='deleted-user-event' AND user_id='session-other'`:    1,
				`SELECT COUNT(*) FROM server_event_rsvps WHERE event_id='other-user-event' AND user_id='session-other'`:           1,
				`SELECT COUNT(*) FROM server_event_deliveries WHERE event_id='other-user-event' AND user_id='session-other'`:      1,
				`SELECT COUNT(*) FROM user_notes WHERE owner_user_id='session-other'`:                                             1,
				`SELECT COUNT(*) FROM user_notes WHERE owner_user_id='session-user'`:                                              0,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/avatars/personal.png'`:                   1,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/dm/shared.bin'`:                          0,
				`SELECT COUNT(*) FROM auth_sessions WHERE user_id='session-user'`:                                                 0,
				`SELECT COUNT(*) FROM messages WHERE id='shared-channel-message' AND content='opaque-channel-ciphertext'`:         1,
				`SELECT COUNT(*) FROM channel_sender_key_envelopes WHERE id='sealed' AND ciphertext='sealed-for-survivor'`:        1,
				`SELECT COUNT(*) FROM group_dm_channels WHERE id='shared-group'`:                                                  1,
				`SELECT COUNT(*) FROM group_dm_channels WHERE id='private-group'`:                                                 0,
				`SELECT COUNT(*) FROM group_dm_messages WHERE id='shared-group-message' AND ciphertext='opaque-group-ciphertext'`: 1,
				`SELECT COUNT(*) FROM group_dm_members WHERE group_id='shared-group' AND user_id='session-user'`:                  0,
				`SELECT COUNT(*) FROM group_dm_members WHERE group_id='shared-group' AND user_id='session-other'`:                 1,
				`SELECT COUNT(*) FROM group_dm_reactions WHERE id='deleted-user-reaction'`:                                        0,
				`SELECT COUNT(*) FROM group_dm_reactions WHERE id='survivor-reaction'`:                                            1,
				`SELECT COUNT(*) FROM group_dm_reads WHERE group_id='shared-group' AND user_id='session-user'`:                    0,
				`SELECT COUNT(*) FROM group_dm_reads WHERE group_id='shared-group' AND user_id='session-other'`:                   1,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/group-dms/shared.bin'`:                   0,
				`SELECT COUNT(*) FROM account_asset_cleanup WHERE file_url='/api/uploads/group-dms/private.bin'`:                  1,
			} {
				var got int
				if err := db.Conn.QueryRow(query).Scan(&got); err != nil || got != want {
					t.Fatalf("%s: got %d want %d: %v", query, got, want, err)
				}
			}
			var groupOwner string
			var groupEpoch int
			if err := db.Conn.QueryRow(`SELECT owner_id,key_epoch FROM group_dm_channels WHERE id='shared-group'`).Scan(&groupOwner, &groupEpoch); err != nil {
				t.Fatal(err)
			}
			if groupOwner != "session-other" || groupEpoch != 5 {
				t.Fatalf("shared group was not transferred and rekeyed: owner=%s epoch=%d", groupOwner, groupEpoch)
			}
			var content string
			if err := db.Conn.QueryRow(`SELECT content FROM dm_messages WHERE id='shared-message'`).Scan(&content); err != nil || content != "opaque-ciphertext" {
				t.Fatalf("ciphertext changed: %v", err)
			}
			if _, err := sessions.GetActive(ctx, a.UserID, a.ID, now); err == nil {
				t.Fatal("old bearer remained active")
			}
			if _, err := refresh.GetByRefreshToken(ctx, old.RefreshToken); err == nil {
				t.Fatal("old refresh remained active")
			}
			if _, err := sessions.GetActive(ctx, b.UserID, b.ID, now); err != nil {
				t.Fatal("surviving session changed", err)
			}
			if _, err := db.Conn.Exec(`UPDATE users SET display_name='late profile write' WHERE id=?`, a.UserID); err == nil {
				t.Fatal("stale profile write re-personalized deleted identity")
			}
			for _, query := range []string{
				`INSERT INTO user_preferences(user_id,data) VALUES('session-user','{"restored":true}')`,
				`INSERT INTO server_members(server_id,user_id) VALUES('preserved-server','session-user')`,
				`INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('late-message','shared-dm','session-user','late')`,
				`UPDATE servers SET owner_id='session-user' WHERE id='preserved-server'`,
				`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('late-bot','latebot','!disabled!',1,'session-user')`,
				`INSERT INTO friendships(id,user_id,friend_id) VALUES('late-friend','session-other','session-user')`,
				`UPDATE channel_sender_key_envelopes SET ciphertext='late replacement' WHERE id='sealed'`,
				`DELETE FROM users WHERE id='session-user'`,
				`UPDATE dm_messages SET content='late edit' WHERE id='shared-message'`,
				`UPDATE messages SET content='late edit' WHERE id='shared-channel-message'`,
				`INSERT INTO dm_attachments(id,dm_message_id,filename,file_url) VALUES('late-attachment','shared-message','late','/api/uploads/late.bin')`,
				`INSERT INTO attachments(id,message_id,filename,file_url) VALUES('late-channel-attachment','shared-channel-message','late','/api/uploads/late2.bin')`,
				`INSERT INTO app_logs(user_id,message) VALUES('session-user','late personal log')`,
			} {
				if _, err := db.Conn.Exec(query); err == nil {
					t.Fatalf("deleted-state barrier accepted: %s", query)
				}
			}
			if err := NewSQLiteUserRepo(wrapForRepo(db)).HardDeleteUser(ctx, a.UserID, b.UserID); err == nil {
				t.Fatal("administrative delete cascaded retained history")
			}
			if _, err := db.Conn.Exec(`UPDATE dm_messages SET is_pinned=1 WHERE id='shared-message'`); err != nil {
				t.Fatal("surviving participant could not pin retained history", err)
			}
			var retainedMessages int
			if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id='shared-dm'`).Scan(&retainedMessages); err != nil || retainedMessages != 2 {
				t.Fatal("failed administrative delete changed shared history", retainedMessages, err)
			}
			if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); err == nil {
				t.Fatal("deleted twice")
			}
		})
	}
}

func TestSQLiteAccountAnonymizationBlockersAndRollback(t *testing.T) {
	db, sessions, _ := authSessionRepoFixture(t)
	a, _ := createLogicalSession(t, sessions, "session-user", "delete-actor", "delete-refresh")
	r := NewSQLiteAccountAnonymizationRepo(wrapForRepo(db))
	ctx := context.Background()
	now := time.Now().Unix()
	if err := r.Anonymize(ctx, a.UserID, a.ID, "wrong", "", now); err == nil {
		t.Fatal("wrong proof accepted")
	}
	if err := r.Anonymize(ctx, "session-other", a.ID, "hash", "", now); err == nil {
		t.Fatal("session crossed owner")
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_admin=1 WHERE id=?`, a.UserID); err != nil {
		t.Fatal(err)
	}
	if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); !errors.Is(err, ErrDeletionAdmin) {
		t.Fatal("admin not blocked", err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_admin=0 WHERE id=?`, a.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO servers(id,name,owner_id) VALUES('owned-delete','Owned',?)`, a.UserID); err != nil {
		t.Fatal(err)
	}
	if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); !errors.Is(err, ErrDeletionOwnsServers) {
		t.Fatal("server not blocked", err)
	}
	if _, err := db.Conn.Exec(`UPDATE servers SET owner_id='session-other' WHERE id='owned-delete'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('owned-bot','ownedbot','!disabled!',1,?)`, a.UserID); err != nil {
		t.Fatal(err)
	}
	if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); !errors.Is(err, ErrDeletionOwnsBots) {
		t.Fatal("bot not blocked", err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET owner_user_id='session-other' WHERE id='owned-bot'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/avatars/rollback.png' WHERE id=?`, a.UserID); err != nil {
		t.Fatal(err)
	}
	installUpdateColumnFailure(t, db, "fail_anonymization", "users", "deleted_at")
	if err := r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now); err == nil {
		t.Fatal("injected failure succeeded")
	}
	if _, err := sessions.GetActive(ctx, a.UserID, a.ID, now); err != nil {
		t.Fatal("failed deletion revoked session", err)
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM account_asset_cleanup`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed deletion queued blobs", count, err)
	}
	dropFailureTrigger(t, db, "fail_anonymization", "users")
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r.Anonymize(ctx, a.UserID, a.ID, "hash", "", now) == nil {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("deletion winners=%d", wins.Load())
	}
}

func installUpdateColumnFailure(t testing.TB, db *database.DB, name, table, column string) {
	t.Helper()
	query := fmt.Sprintf("CREATE TRIGGER %s BEFORE UPDATE OF %s ON %s BEGIN SELECT RAISE(ABORT,'test injected failure'); END", name, column, table)
	if database.IsPostgres(db.Conn) {
		query = fmt.Sprintf("CREATE FUNCTION fn_%s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test injected failure'; END $$; CREATE TRIGGER %s BEFORE UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION fn_%s()", name, name, column, table, name)
	}
	if _, err := db.Conn.Exec(query); err != nil {
		t.Fatal(err)
	}
}
