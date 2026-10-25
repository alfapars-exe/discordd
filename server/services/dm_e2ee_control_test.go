package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

func TestDMEncryptionControlIsHumanOnly(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x'),('outsider','outsider','x');
		INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner'),('legacy','legacybot','x',1,'owner');`); err != nil {
		t.Fatal(err)
	}
	bots := NewBotService(repository.NewBotRepository(db.Conn))
	if _, err := bots.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	dm := repository.NewSQLiteDMRepo(db.Conn)
	svc := NewDMService(dm, repository.NewSQLiteUserRepo(db.Conn), &testutil.MockBroadcaster{}, nil, nil, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	for _, bot := range []string{"game", "legacy"} {
		ch := &models.DMChannel{User1ID: "alice", User2ID: bot, Status: models.DMStatusAccepted}
		if err := dm.CreateChannel(ctx, ch); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.ToggleE2EE(ctx, "alice", ch.ID, true); err != nil {
			t.Fatal(err)
		}
		for _, enabled := range []bool{false, true} {
			if _, err := svc.ToggleE2EE(ctx, bot, ch.ID, enabled); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("bot %s toggle=%v", bot, err)
			}
		}
		stored, err := dm.GetChannelByID(ctx, ch.ID)
		if err != nil || !stored.E2EEEnabled {
			t.Fatalf("bot disabled encryption: %+v %v", stored, err)
		}
		if _, err := svc.ToggleE2EE(ctx, "outsider", ch.ID, false); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("nonmember human toggle=%v", err)
		}
		if _, err := svc.ToggleE2EE(ctx, "alice", ch.ID, false); err != nil {
			t.Fatalf("human control changed=%v", err)
		}
	}
}
