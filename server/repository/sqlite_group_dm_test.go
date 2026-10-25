package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMRepositoryMembershipRotatesOnlyOnChange(t *testing.T) {
	db := newTestDB(t)
	for _, row := range []struct{ id, name string }{{"g-owner", "groupowner"}, {"g-one", "groupone"}, {"g-two", "grouptwo"}} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?, 'x')`, row.id, row.name); err != nil {
			t.Fatal(err)
		}
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	ctx := context.Background()
	g := &models.GroupDM{ID: "gdm-test", OwnerID: "g-owner", Name: "Team", KeyEpoch: 1, CallRoomKey: "gdm-room-test"}
	if err := repo.Create(ctx, g, []string{"g-owner", "g-one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMember(ctx, g.ID, "g-one"); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("duplicate add = %v", err)
	}
	got, _ := repo.GetByID(ctx, g.ID)
	if got.KeyEpoch != 1 {
		t.Fatalf("no-op add rotated epoch to %d", got.KeyEpoch)
	}
	epoch, err := repo.AddMember(ctx, g.ID, "g-two")
	if err != nil || epoch != 2 {
		t.Fatalf("add = epoch %d, %v", epoch, err)
	}
	if _, err := repo.RemoveMember(ctx, g.ID, "missing"); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("missing remove = %v", err)
	}
	got, _ = repo.GetByID(ctx, g.ID)
	if got.KeyEpoch != 2 {
		t.Fatalf("no-op remove rotated epoch to %d", got.KeyEpoch)
	}
	epoch, err = repo.RemoveMember(ctx, g.ID, "g-two")
	if err != nil || epoch != 3 {
		t.Fatalf("remove = epoch %d, %v", epoch, err)
	}
}

func TestGroupDMDeletePreservesReadAndUnreadCounts(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('sender','sender','x'),('reader','reader','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	group := &models.GroupDM{ID: "delete-counts", OwnerID: "sender", Name: "Counts", KeyEpoch: 1, CallRoomKey: "counts-room"}
	if err := repo.Create(ctx, group, []string{"sender", "reader"}); err != nil {
		t.Fatal(err)
	}
	cipher, device, metadata := "cipher", "device", "{}"
	create := func(id string) {
		t.Helper()
		if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: id, GroupID: group.ID, UserID: "sender", EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &metadata, KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET created_at='2026-10-24 12:00:00' WHERE id=?`, id); err != nil {
			t.Fatal(err)
		}
	}
	create("count-1")
	create("count-2")
	anchor := "count-2"
	if err := repo.MarkRead(ctx, group.ID, "reader", &anchor); err != nil {
		t.Fatal(err)
	}
	create("count-3")
	for _, step := range []struct {
		id   string
		want int
	}{{"count-1", 1}, {"count-2", 1}, {"count-3", 0}} {
		if err := repo.DeleteMessage(ctx, group.ID, step.id, "sender"); err != nil {
			t.Fatal(err)
		}
		if got, err := repo.UnreadCount(ctx, group.ID, "reader"); err != nil || got != step.want {
			t.Fatalf("after deleting %s: count=%d want=%d err=%v", step.id, got, step.want, err)
		}
	}
}

func TestGroupDMRepositoryMessagesAreScopedAndPaginated(t *testing.T) {
	db := newTestDB(t)
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('g-owner','groupowner','x'),('g-one','groupone','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	ctx := context.Background()
	for _, id := range []string{"group-a", "group-b"} {
		if err := repo.Create(ctx, &models.GroupDM{ID: id, OwnerID: "g-owner", Name: id, KeyEpoch: 1, CallRoomKey: "room-" + id}, []string{"g-owner", "g-one"}); err != nil {
			t.Fatal(err)
		}
	}
	ciphertext, device, metadata := `[]`, "device", `{}`
	first := &models.GroupDMMessage{ID: "gm-1", GroupID: "group-a", UserID: "g-owner", EncryptionVersion: 1, Ciphertext: &ciphertext, SenderDeviceID: &device, E2EEMetadata: &metadata, KeyEpoch: 1}
	if err := repo.CreateMessage(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := &models.GroupDMMessage{ID: "gm-2", GroupID: "group-a", UserID: "g-one", EncryptionVersion: 1, Ciphertext: &ciphertext, SenderDeviceID: &device, E2EEMetadata: &metadata, KeyEpoch: 1, ReplyToID: &first.ID}
	if err := repo.CreateMessage(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.GetMessage(ctx, "group-b", first.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-group message read = %v", err)
	}
	items, err := repo.ListMessages(ctx, "group-a", "", 10)
	if err != nil || len(items) != 2 || items[0].ID != second.ID {
		t.Fatalf("messages = %#v, %v", items, err)
	}
}

func TestGroupDMRepositoryMessageInteractionsAndReads(t *testing.T) {
	db := newTestDB(t)
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('g-owner','groupowner','x'),('g-one','groupone','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	ctx := context.Background()
	g := &models.GroupDM{ID: "group-interactions", OwnerID: "g-owner", Name: "Team", KeyEpoch: 1, CallRoomKey: "room-interactions"}
	if err := repo.Create(ctx, g, []string{"g-owner", "g-one"}); err != nil {
		t.Fatal(err)
	}
	cipher, device, meta := `[{"ciphertext":"old"}]`, "device", `{}`
	m := &models.GroupDMMessage{ID: "gm-actions", GroupID: g.ID, UserID: "g-owner", EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}
	if err := repo.CreateMessage(ctx, m); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.UnreadCount(ctx, g.ID, "g-one"); err != nil || got != 1 {
		t.Fatalf("unread=%d,%v", got, err)
	}
	if err := repo.MarkRead(ctx, g.ID, "g-one", &m.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.UnreadCount(ctx, g.ID, "g-one"); got != 0 {
		t.Fatalf("read did not clear: %d", got)
	}
	newCipher := `[{"ciphertext":"new"}]`
	if err := repo.UpdateMessage(ctx, g.ID, m.ID, "g-one", &models.UpdateGroupDMMessageRequest{Ciphertext: &newCipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("other user edit=%v", err)
	}
	if err := repo.UpdateMessage(ctx, g.ID, m.ID, "g-owner", &models.UpdateGroupDMMessageRequest{Ciphertext: &newCipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	if added, err := repo.ToggleReaction(ctx, m.ID, "g-one", "👍"); err != nil || !added {
		t.Fatalf("reaction add=%v,%v", added, err)
	}
	reactions, err := repo.GetReactions(ctx, []string{m.ID})
	if err != nil || len(reactions[m.ID]) != 1 || reactions[m.ID][0].Count != 1 {
		t.Fatalf("reactions=%#v,%v", reactions, err)
	}
	if added, err := repo.ToggleReaction(ctx, m.ID, "g-one", "👍"); err != nil || added {
		t.Fatalf("reaction remove=%v,%v", added, err)
	}
	size := int64(3)
	mime := "application/octet-stream"
	attachment := &models.GroupDMAttachment{GroupMessageID: m.ID, Filename: "encrypted.bin", FileURL: "/api/uploads/group-encrypted.bin", FileSize: &size, MimeType: &mime}
	if err := repo.CreateAttachment(ctx, attachment); err != nil {
		t.Fatal(err)
	}
	gotAttachment, err := repo.GetAttachmentByFileURL(ctx, attachment.FileURL)
	if err != nil || gotAttachment.GroupMessageID != m.ID {
		t.Fatalf("attachment=%#v,%v", gotAttachment, err)
	}
	if err := repo.DeleteMessage(ctx, g.ID, m.ID, "g-one"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("other user delete=%v", err)
	}
	if err := repo.DeleteMessage(ctx, g.ID, m.ID, "g-owner"); err != nil {
		t.Fatal(err)
	}
}
