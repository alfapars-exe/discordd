package repository

import (
	"context"
	"database/sql"
	"errors"
	"github.com/argeinfina/hichat/database"
	"testing"
)

func TestRetiredApplicationTokenBarriersAndValidation(t *testing.T) {
	db, _, _ := authSessionRepoFixture(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('active-app','activeapp','!disabled!',1,'session-user'),('retired-app','retiredapp','!deleted!',1,NULL)`},
		{q: `UPDATE users SET deleted_at=1 WHERE id='retired-app'`},
		{q: `INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('active-token','active-app','active-hash')`},
	})
	for _, target := range []string{"retired-app", "session-user", "missing-user"} {
		if _, err := db.Conn.Exec(`INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('invalid-token',?,'invalid-hash')`, target); err == nil {
			t.Fatal("invalid application received token", target)
		}
		if _, err := db.Conn.Exec(`UPDATE bot_tokens SET bot_user_id=? WHERE id='active-token'`, target); err == nil {
			t.Fatal("token reassigned to invalid application", target)
		}
	}
	repo := NewBotRepository(wrapForRepo(db))
	ctx := context.Background()
	if id, err := repo.BotUserIDByTokenHash(ctx, "active-hash"); err != nil || id != "active-app" {
		t.Fatal("valid bot token rejected", id, err)
	}
	// Legacy/corrupt rows may predate the guard. Lookup independently refuses
	// them; neither trigger presence nor FK enforcement is an auth prerequisite.
	drop := `DROP TRIGGER retired_application_token_insert`
	if database.IsPostgres(db.Conn) {
		drop += ` ON bot_tokens`
	}
	if _, err := db.Conn.Exec(drop); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('legacy-retired','retired-app','retired-hash'),('legacy-human','session-user','human-hash')`); err != nil {
		t.Fatal(err)
	}
	for _, hash := range []string{"retired-hash", "human-hash"} {
		if _, err := repo.BotUserIDByTokenHash(ctx, hash); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("invalid legacy token accepted", hash, err)
		}
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=1 WHERE id='active-app'`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.BotUserIDByTokenHash(ctx, "active-hash"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("banned bot token accepted", err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=0 WHERE id='active-app'; INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES('active-app',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.BotUserIDByTokenHash(ctx, "active-hash"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("disabled bot token accepted", err)
	}
}
