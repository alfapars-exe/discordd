package repository

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"testing"
)

func TestGroupDMEditRechecksMembershipAndEpoch(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('edit-owner','edit-owner','x'),('edit-member','edit-member','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	g := &models.GroupDM{ID: "edit-group", OwnerID: "edit-owner", Name: "Edit", KeyEpoch: 1, CallRoomKey: "edit-room"}
	if err := repo.Create(ctx, g, []string{"edit-owner", "edit-member"}); err != nil {
		t.Fatal(err)
	}
	cipher, device := "original", "device"
	for _, user := range []string{"edit-owner", "edit-member"} {
		if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: user, GroupID: g.ID, UserID: user, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.RemoveMember(ctx, g.ID, "edit-member"); err != nil {
		t.Fatal(err)
	}
	edited := "edited"
	req := &models.UpdateGroupDMMessageRequest{Ciphertext: &edited, SenderDeviceID: &device, KeyEpoch: 1}
	if err := repo.UpdateMessage(ctx, g.ID, "edit-owner", "edit-owner", req); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale epoch edit: %v", err)
	}
	req.KeyEpoch = 2
	if err := repo.UpdateMessage(ctx, g.ID, "edit-member", "edit-member", req); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("removed member edit: %v", err)
	}
	for _, user := range []string{"edit-owner", "edit-member"} {
		msg, err := repo.GetMessage(ctx, g.ID, user)
		if err != nil || msg.Ciphertext == nil || *msg.Ciphertext != "original" || msg.KeyEpoch != 1 {
			t.Fatalf("rejected edit changed message: %+v err=%v", msg, err)
		}
	}
	if err := repo.UpdateMessage(ctx, g.ID, "edit-owner", "edit-owner", req); err != nil {
		t.Fatalf("current member edit: %v", err)
	}
	msg, err := repo.GetMessage(ctx, g.ID, "edit-owner")
	if err != nil || *msg.Ciphertext != edited || msg.KeyEpoch != 2 {
		t.Fatalf("valid edit not saved: %+v err=%v", msg, err)
	}
}
