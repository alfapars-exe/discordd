package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestGameGrantSendPreservesPrivacyAndAtomicRequestState(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,dm_privacy) VALUES('owner','owner','x','message_request'),('alice','alice','x','message_request');
		INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner');`); err != nil {
		t.Fatal(err)
	}
	bots := NewBotService(repository.NewBotRepository(db.Conn))
	if _, err := bots.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	listed, err := bots.ListBots(ctx, "owner")
	if err != nil || len(listed) != 1 || !listed[0].IsGameApplication {
		t.Fatalf("owned type flag=%+v %v", listed, err)
	}
	dm := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "game", Status: models.DMStatusAccepted}
	if err := dm.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	blocked := false
	block := &testutil.MockBlockChecker{IsBlockedFn: func(context.Context, string, string) (bool, error) { return blocked, nil }}
	friends := &testutil.MockFriendshipChecker{AreFriendsFn: func(context.Context, string, string) (bool, error) { return false, nil }}
	var payloads []string
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(_ string, event ws.Event) {
		if event.Op == ws.OpDMMessageCreate {
			b, err := json.Marshal(event.Data)
			if err != nil {
				t.Fatal(err)
			}
			payloads = append(payloads, string(b))
		}
	}}
	svc := NewDMService(dm, repository.NewSQLiteUserRepo(db.Conn), hub, block, friends, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	cipher, device := "opaque-ciphertext", "game-device"
	send := func() (*models.DMMessage, error) {
		return svc.SendMessage(ctx, "game", ch.ID, &models.CreateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device})
	}
	assertNoRequest := func() {
		t.Helper()
		current, err := dm.GetChannelByID(ctx, ch.ID)
		if err != nil || current.Status != models.DMStatusAccepted || current.InitiatedBy != nil {
			t.Fatalf("failed send changed request state: %+v %v", current, err)
		}
		var n int
		if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id=?`, ch.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("failed send persisted message: %d %v", n, err)
		}
	}
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("missing grant=%v", err)
	}
	assertNoRequest()
	if _, err := bots.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := bots.ChangeGameGrant(ctx, "alice", "game", 1, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked grant=%v", err)
	}
	assertNoRequest()
	if _, err := bots.ChangeGameGrant(ctx, "alice", "game", 2, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := bots.ChangeGameGrant(ctx, "alice", "game", 3, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("disabled grant=%v", err)
	}
	assertNoRequest()
	if _, err := bots.ChangeGameGrant(ctx, "alice", "game", 4, true, false); err != nil {
		t.Fatal(err)
	}
	blocked = true
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("block bypass=%v", err)
	}
	assertNoRequest()
	blocked = false
	if _, err := db.Conn.ExecContext(ctx, `UPDATE users SET dm_privacy='friends_only' WHERE id='alice'`); err != nil {
		t.Fatal(err)
	}
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("friends-only bypass=%v", err)
	}
	assertNoRequest()
	if _, err := db.Conn.ExecContext(ctx, `UPDATE users SET dm_privacy='message_request' WHERE id='alice'`); err != nil {
		t.Fatal(err)
	}
	m, err := send()
	if err != nil {
		t.Fatal(err)
	}
	if m.ApplicationID == nil || *m.ApplicationID != "game" || m.Ciphertext == nil || *m.Ciphertext != cipher || m.Content != nil {
		t.Fatalf("send origin/ciphertext=%+v", m)
	}
	svc.BroadcastCreate(m)
	if len(payloads) != 2 {
		t.Fatalf("broadcast recipients=%d", len(payloads))
	}
	for _, p := range payloads {
		if !strings.Contains(p, `"application_id":"game"`) || !strings.Contains(p, `"ciphertext":"opaque-ciphertext"`) {
			t.Fatalf("broadcast origin/payload lost: %s", p)
		}
	}
	if _, err := send(); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("pending request bypass=%v", err)
	}
}
