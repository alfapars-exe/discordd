package repository

import (
	"context"
	"testing"
)

// TestUserScanIncludesBotColumns guards that GetByID hydrates the bot
// identity columns added in migration 072 (a missing scan target silently
// leaves IsBot=false for real bots, which would let a bot pass human-only gates).
func TestUserScanIncludesBotColumns(t *testing.T) {
	db := newTxTestDB(t) // sibling helper: boots a file DB with all embedded migrations
	ctx := context.Background()

	// owner_user_id has a FK to users(id) (foreign_keys are ON for the test DB),
	// so the human owner row must exist before the bot can reference it.
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_1','owner','x')`); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, display_name, password_hash, status, language, is_bot, owner_user_id, created_at)
		 VALUES ('bot_x','testbot','Test Bot','!disabled!','online','en',1,'owner_1',CURRENT_TIMESTAMP)`); err != nil {
		t.Fatalf("seed bot: %v", err)
	}

	repo := NewSQLiteUserRepo(db.Conn)
	u, err := repo.GetByID(ctx, "bot_x")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if !u.IsBot {
		t.Fatal("expected IsBot=true")
	}
	if u.OwnerUserID == nil || *u.OwnerUserID != "owner_1" {
		t.Fatalf("expected OwnerUserID=owner_1, got %v", u.OwnerUserID)
	}
}
