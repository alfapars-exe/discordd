package services

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// newBotTestDB boots a throwaway file-backed DB with the full embedded migration
// set (mirrors repository.newTxTestDB, which is unexported to this package) so
// the BotService runs against the real schema with FKs enforced.
func newBotTestDB(t *testing.T) *database.DB {
	t.Helper()
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "bot_test.db"), migrationsFS)
	if err != nil {
		t.Fatalf("database.New: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestBotService_CreateAndValidate(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()

	// CreateBot requires an existing owner user (FK owner_user_id -> users.id).
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_1','owner','x')`); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	svc := NewBotService(repository.NewBotRepository(db.Conn))

	bot, token, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{
		Username: "weatherbot", DisplayName: "Weather",
	})
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if !bot.IsBot || bot.OwnerUserID == nil || *bot.OwnerUserID != "owner_1" {
		t.Fatalf("bad bot identity: %+v", bot)
	}
	if bot.ID == "" {
		t.Fatal("expected a generated bot id")
	}

	gotID, err := svc.ValidateBotToken(ctx, token)
	if err != nil {
		t.Fatalf("ValidateBotToken: %v", err)
	}
	if gotID != bot.ID {
		t.Fatalf("validated wrong bot: %s != %s", gotID, bot.ID)
	}

	if _, err := svc.ValidateBotToken(ctx, "hb_not_a_real_token"); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("expected ErrBotTokenInvalid for bogus token, got %v", err)
	}
	if _, err := svc.ValidateBotToken(ctx, "jwt.without.prefix"); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("expected ErrBotTokenInvalid for non-bot token, got %v", err)
	}

	if err := svc.RevokeAllTokens(ctx, "owner_1", bot.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := svc.ValidateBotToken(ctx, token); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("expected ErrBotTokenInvalid after revoke, got %v", err)
	}

	bots, err := svc.ListBots(ctx, "owner_1")
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if len(bots) != 1 || bots[0].ID != bot.ID {
		t.Fatalf("expected one owned bot %s, got %+v", bot.ID, bots)
	}
}

// TestBotService_RevokeIsolation_AcrossBots verifies that revoking one bot's
// tokens leaves a sibling bot (same owner) fully usable.
func TestBotService_RevokeIsolation_AcrossBots(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()

	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_1','owner','x')`); err != nil {
		t.Fatalf("seed owner: %v", err)
	}

	svc := NewBotService(repository.NewBotRepository(db.Conn))

	botA, tokenA, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{
		Username: "botalpha", DisplayName: "Alpha",
	})
	if err != nil {
		t.Fatalf("CreateBot A: %v", err)
	}
	botB, tokenB, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{
		Username: "botbravo", DisplayName: "Bravo",
	})
	if err != nil {
		t.Fatalf("CreateBot B: %v", err)
	}

	if err := svc.RevokeAllTokens(ctx, "owner_1", botB.ID); err != nil {
		t.Fatalf("RevokeAllTokens B: %v", err)
	}

	gotA, err := svc.ValidateBotToken(ctx, tokenA)
	if err != nil {
		t.Fatalf("ValidateBotToken A after revoking B: %v", err)
	}
	if gotA != botA.ID {
		t.Fatalf("validated wrong bot for A: %s != %s", gotA, botA.ID)
	}

	if _, err := svc.ValidateBotToken(ctx, tokenB); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("expected ErrBotTokenInvalid for revoked bot B, got %v", err)
	}
}

// TestBotService_RevokeIsolation_AcrossOwners verifies that one owner cannot
// revoke another owner's bot tokens: the call is a no-op and the token stays valid.
func TestBotService_RevokeIsolation_AcrossOwners(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()

	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_1','owner1','x')`); err != nil {
		t.Fatalf("seed owner_1: %v", err)
	}
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_2','owner2','x')`); err != nil {
		t.Fatalf("seed owner_2: %v", err)
	}

	svc := NewBotService(repository.NewBotRepository(db.Conn))

	bot, token, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{
		Username: "botcharlie", DisplayName: "Charlie",
	})
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	// owner_2 attempting to revoke owner_1's bot must be a harmless no-op.
	if err := svc.RevokeAllTokens(ctx, "owner_2", bot.ID); err != nil {
		t.Fatalf("RevokeAllTokens by wrong owner should be nil, got %v", err)
	}

	gotID, err := svc.ValidateBotToken(ctx, token)
	if err != nil {
		t.Fatalf("ValidateBotToken after cross-owner revoke attempt: %v", err)
	}
	if gotID != bot.ID {
		t.Fatalf("validated wrong bot: %s != %s", gotID, bot.ID)
	}
}
