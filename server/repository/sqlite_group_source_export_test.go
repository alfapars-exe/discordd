package repository

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"testing"
)

func TestGroupSourceExportIsSelfAuthoredOpaqueAndLossless(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	groups := NewSQLiteGroupDMRepo(wrapForRepo(db))
	id := "group-export-source"
	if err := groups.Create(ctx, &models.GroupDM{ID: id, OwnerID: dmAlice, Name: id, KeyEpoch: 1, CallRoomKey: id}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	cipher, device := "own-opaque-ciphertext", "device"
	own := &models.GroupDMMessage{ID: "own-group-export", GroupID: id, UserID: dmAlice, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1, SourceSequence: 9007199254740993}
	if err := groups.CreateMessage(ctx, own); err != nil {
		t.Fatal(err)
	}
	otherCipher := "other-private-ciphertext"
	if err := groups.CreateMessage(ctx, &models.GroupDMMessage{ID: "other-group-export", GroupID: id, UserID: dmBob, EncryptionVersion: 1, Ciphertext: &otherCipher, SenderDeviceID: &device, KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	user, err := NewSQLiteUserRepo(wrapForRepo(db)).GetByID(ctx, dmAlice)
	if err != nil {
		t.Fatal(err)
	}
	exports := NewSQLiteDataExportRepo(wrapForRepo(db))
	job, err := exports.Create(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := exports.Download(ctx, dmAlice, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		GroupMessages []struct {
			ID         string  `json:"id"`
			Ciphertext string  `json:"ciphertext"`
			Sequence   string  `json:"source_sequence"`
			Content    *string `json:"content"`
		} `json:"group_messages"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.GroupMessages) != 1 || document.GroupMessages[0].ID != own.ID || document.GroupMessages[0].Ciphertext != cipher || document.GroupMessages[0].Sequence != "9007199254740993" || document.GroupMessages[0].Content != nil {
		t.Fatalf("export leaked/rounded group source: %+v", document.GroupMessages)
	}
}
