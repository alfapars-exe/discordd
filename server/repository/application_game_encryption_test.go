package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGameGrantEncryptedChannelRejectsPlaintextMutation(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner'),('legacy','legacybot','x',1,'owner')`, nil}})
	ch := newDMChannel(t, ctx, dm, "alice", "game", models.DMStatusAccepted)
	if err := dm.SetE2EEEnabled(ctx, ch.ID, true); err != nil {
		t.Fatal(err)
	}
	historicalText := "historical plaintext before game registration"
	historical := &models.DMMessage{UserID: "game", DMChannelID: ch.ID, Content: &historicalText}
	if err := dm.CreateMessage(ctx, historical); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	content, cipher, device, blank := "must not be stored as plaintext", "opaque-encrypted-content", "device", "   "
	send := func(m *models.DMMessage) error {
		m.UserID = "game"
		m.DMChannelID = ch.ID
		return NewDMMessageTxRunner(db.Conn).InTx(ctx, func(tx *DMTxRepos) error { return tx.DM.CreateMessage(ctx, m) })
	}
	for name, m := range map[string]*models.DMMessage{
		"plaintext":          {Content: &content},
		"mixed":              {Content: &content, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device},
		"blank-ciphertext":   {EncryptionVersion: 1, Ciphertext: &blank, SenderDeviceID: &device},
		"missing-ciphertext": {EncryptionVersion: 1, SenderDeviceID: &device},
	} {
		if err := send(m); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("%s game payload=%v", name, err)
		}
	}
	m := &models.DMMessage{EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device}
	if err := send(m); err != nil {
		t.Fatal(err)
	}
	for name, req := range map[string]*models.UpdateDMMessageRequest{
		"plaintext":          {Content: content},
		"mixed":              {Content: content, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device},
		"missing-ciphertext": {EncryptionVersion: 1, SenderDeviceID: &device},
	} {
		if err := dm.UpdateMessage(ctx, m.ID, req); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("%s game edit=%v", name, err)
		}
	}
	updated := "updated-opaque-ciphertext"
	if err := dm.UpdateMessage(ctx, m.ID, &models.UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &updated, SenderDeviceID: &device}); err != nil {
		t.Fatal(err)
	}
	if err := dm.UpdateMessage(ctx, historical.ID, &models.UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &updated, SenderDeviceID: &device}); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("unsupported historical encryption conversion=%v", err)
	}
	old, err := dm.GetMessageByID(ctx, historical.ID)
	if err != nil || old.EncryptionVersion != 0 || old.Content == nil || *old.Content != historicalText || old.Ciphertext != nil || old.ApplicationID != nil {
		t.Fatalf("historical format/origin changed: %+v %v", old, err)
	}
	badMIME := "image/png"
	opaqueMIME := "application/octet-stream"
	for _, mime := range []*string{nil, &badMIME} {
		if err := dm.CreateAttachment(ctx, &models.DMAttachment{DMMessageID: m.ID, Filename: "bad.bin", FileURL: "/api/uploads/bad.bin", MimeType: mime}); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("nonopaque metadata accepted=%v", err)
		}
	}
	if err := dm.CreateAttachment(ctx, &models.DMAttachment{DMMessageID: m.ID, Filename: "encrypted_0.bin", FileURL: "/api/uploads/encrypted.bin", MimeType: &opaqueMIME}); err != nil {
		t.Fatal(err)
	}
	stored, err := dm.GetMessageByID(ctx, m.ID)
	if err != nil || stored.Content != nil || stored.Ciphertext == nil || *stored.Ciphertext != updated || stored.ApplicationID == nil || *stored.ApplicationID != "game" {
		t.Fatalf("encrypted content/origin changed: %+v %v", stored, err)
	}
	var count int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_messages WHERE user_id='game'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("invalid game sends persisted: %d %v", count, err)
	}
	// This change does not redefine the legacy human/bot plaintext policy.
	human := &models.DMMessage{UserID: "alice", DMChannelID: ch.ID, Content: &content}
	if err := dm.CreateMessage(ctx, human); err != nil {
		t.Fatalf("human behavior changed: %v", err)
	}
	legacyCh := newDMChannel(t, ctx, dm, "alice", "legacy", models.DMStatusAccepted)
	if err := dm.SetE2EEEnabled(ctx, legacyCh.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := dm.CreateMessage(ctx, &models.DMMessage{UserID: "legacy", DMChannelID: legacyCh.ID, Content: &content}); err != nil {
		t.Fatalf("legacy bot behavior changed: %v", err)
	}
}
