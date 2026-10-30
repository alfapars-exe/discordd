package services

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type botDisconnectRecorder struct{ ids []string }

func (r *botDisconnectRecorder) DisconnectUser(id string) { r.ids = append(r.ids, id) }

// newBotTestDB boots a throwaway file-backed DB with the full embedded migration
// set (mirrors repository.newTxTestDB, which is unexported to this package) so
// the BotService runs against the real schema with FKs enforced.
func newBotTestDB(t *testing.T) *database.DB {
	t.Helper()
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("fs.Sub: %v", err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "bot_test.db"), migrationsFS)
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

func TestBotService_CreateRollsBackIdentityWhenInitialTokenFails(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('owner_1','owner','x');
		 CREATE TRIGGER reject_fixture_bot_token BEFORE INSERT ON bot_tokens
		 BEGIN SELECT RAISE(ABORT, 'fixture token failure'); END;`); err != nil {
		t.Fatalf("seed fixture: %v", err)
	}
	svc := NewBotService(repository.NewBotRepository(db.Conn))
	if _, token, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{Username: "atomicbot", DisplayName: "Atomic"}); err == nil || token != "" {
		t.Fatalf("CreateBot = token %q, err %v; want no exposed credential and an error", token, err)
	}
	var bots int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE owner_user_id='owner_1'`).Scan(&bots); err != nil {
		t.Fatal(err)
	}
	if bots != 0 {
		t.Fatalf("stranded bot identities = %d, want 0", bots)
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

	disconnects := &botDisconnectRecorder{}
	svc := NewBotService(repository.NewBotRepository(db.Conn), disconnects)

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
	if len(disconnects.ids) != 1 || disconnects.ids[0] != botB.ID {
		t.Fatalf("runtime disconnects = %v, want only %s", disconnects.ids, botB.ID)
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
// revoke another owner's bot tokens: the call returns not-found, does not
// disconnect the foreign identity, and the token stays valid.
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

	disconnects := &botDisconnectRecorder{}
	svc := NewBotService(repository.NewBotRepository(db.Conn), disconnects)

	bot, token, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{
		Username: "botcharlie", DisplayName: "Charlie",
	})
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	if err := svc.RevokeAllTokens(ctx, "owner_2", bot.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("RevokeAllTokens by wrong owner = %v, want not found", err)
	}
	if len(disconnects.ids) != 0 {
		t.Fatalf("foreign bot was disconnected: %v", disconnects.ids)
	}

	gotID, err := svc.ValidateBotToken(ctx, token)
	if err != nil {
		t.Fatalf("ValidateBotToken after cross-owner revoke attempt: %v", err)
	}
	if gotID != bot.ID {
		t.Fatalf("validated wrong bot: %s != %s", gotID, bot.ID)
	}
}

func TestBotService_OwnershipTransferRequiresRecipientAndRotatesCredential(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES
		('owner_1','owner1','x'),('recipient_1','recipient1','x'),('stranger_1','stranger1','x')`); err != nil {
		t.Fatal(err)
	}
	disconnects := &botDisconnectRecorder{}
	svc := NewBotService(repository.NewBotRepository(db.Conn), disconnects)
	bot, oldToken, err := svc.CreateBot(ctx, "owner_1", models.CreateBotRequest{Username: "transferbot", DisplayName: "Transfer"})
	if err != nil {
		t.Fatal(err)
	}
	request, err := svc.RequestOwnershipTransfer(ctx, "owner_1", bot.ID, "recipient1")
	if err != nil {
		t.Fatal(err)
	}
	if request.ToUserID != "recipient_1" || request.FromUserID != "owner_1" {
		t.Fatalf("bad request: %+v", request)
	}
	if _, err := svc.ResolveOwnershipTransfer(ctx, "stranger_1", request.ID, true); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("stranger accept = %v", err)
	}
	newToken, err := svc.ResolveOwnershipTransfer(ctx, "recipient_1", request.ID, true)
	if err != nil || newToken == "" {
		t.Fatalf("recipient accept token=%q err=%v", newToken, err)
	}
	if _, err := svc.ValidateBotToken(ctx, oldToken); !errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("old token survived: %v", err)
	}
	if got, err := svc.ValidateBotToken(ctx, newToken); err != nil || got != bot.ID {
		t.Fatalf("new token got=%q err=%v", got, err)
	}
	oldBots, _ := svc.ListBots(ctx, "owner_1")
	newBots, _ := svc.ListBots(ctx, "recipient_1")
	if len(oldBots) != 0 || len(newBots) != 1 || newBots[0].ID != bot.ID {
		t.Fatalf("ownership old=%+v new=%+v", oldBots, newBots)
	}
	if len(disconnects.ids) != 1 || disconnects.ids[0] != bot.ID {
		t.Fatalf("disconnects=%v", disconnects.ids)
	}
}
