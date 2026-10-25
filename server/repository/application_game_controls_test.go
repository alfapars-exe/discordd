package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGameGrantReactionsAndPinsUseActorNotMessageAuthor(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner'),('legacy','legacybot','x',1,'owner')`, nil}})
	ch := newDMChannel(t, ctx, dm, "alice", "game", models.DMStatusAccepted)
	content := "human authored message"
	m := &models.DMMessage{UserID: "alice", DMChannelID: ch.ID, Content: &content}
	if err := dm.CreateMessage(ctx, m); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	if _, err := dm.ToggleReaction(ctx, m.ID, "game", "👍"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("missing grant reaction bypass=%v", err)
	}
	if err := dm.PinMessageAs(ctx, "game", m.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("missing grant pin bypass=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	if added, err := dm.ToggleReaction(ctx, m.ID, "game", "👍"); err != nil || !added {
		t.Fatalf("enabled reaction=%t %v", added, err)
	}
	if err := dm.PinMessageAs(ctx, "game", m.ID); err != nil {
		t.Fatalf("enabled pin=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 1, false, false); err != nil {
		t.Fatal(err)
	}
	if added, err := dm.ToggleReaction(ctx, m.ID, "game", "👍"); err != nil || added {
		t.Fatalf("disabled reaction cleanup=%t %v", added, err)
	}
	if err := dm.UnpinMessage(ctx, m.ID); err != nil {
		t.Fatalf("disabled unpin cleanup=%v", err)
	}
	for _, emoji := range []string{"👍", "🎉"} {
		if _, err := dm.ToggleReaction(ctx, m.ID, "game", emoji); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("disabled new reaction=%v", err)
		}
	}
	if err := dm.PinMessageAs(ctx, "game", m.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("disabled pin=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 2, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := dm.ToggleReaction(ctx, m.ID, "game", "👍"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 3, false, true); err != nil {
		t.Fatal(err)
	}
	if added, err := dm.ToggleReaction(ctx, m.ID, "game", "👍"); err != nil || added {
		t.Fatalf("revoked reaction cleanup=%t %v", added, err)
	}
	if _, err := dm.ToggleReaction(ctx, m.ID, "game", "🎉"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked reaction bypass=%v", err)
	}
	if err := dm.PinMessageAs(ctx, "game", m.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked pin bypass=%v", err)
	}
	if err := dm.PinMessageAs(ctx, "alice", m.ID); err != nil {
		t.Fatalf("human pin gated by other user's game type=%v", err)
	}
	reactions, err := dm.GetReactionsByMessageID(ctx, m.ID)
	if err != nil || len(reactions) != 0 {
		t.Fatalf("forbidden reactions persisted: %+v %v", reactions, err)
	}
	legacyCh := newDMChannel(t, ctx, dm, "alice", "legacy", models.DMStatusAccepted)
	legacyMessage := &models.DMMessage{UserID: "alice", DMChannelID: legacyCh.ID, Content: &content}
	if err := dm.CreateMessage(ctx, legacyMessage); err != nil {
		t.Fatal(err)
	}
	if added, err := dm.ToggleReaction(ctx, legacyMessage.ID, "legacy", "👍"); err != nil || !added {
		t.Fatalf("legacy reaction changed=%t %v", added, err)
	}
	if err := dm.PinMessageAs(ctx, "legacy", legacyMessage.ID); err != nil {
		t.Fatalf("legacy pin changed=%v", err)
	}
}
