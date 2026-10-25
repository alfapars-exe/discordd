package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMReadStateOldestUnreadAnchorAndDeletedCursorRepair(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	groupID := "unread-anchor-group"
	if err := repo.Create(ctx, &models.GroupDM{ID: groupID, OwnerID: dmAlice, Name: "Unread", KeyEpoch: 1, CallRoomKey: "room"}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	create := func(id, author, created string) {
		t.Helper()
		message := &models.GroupDMMessage{ID: id, GroupID: groupID, UserID: author, EncryptionVersion: 1, Ciphertext: groupAnchorString("cipher"), SenderDeviceID: groupAnchorString("device"), E2EEMetadata: groupAnchorString("{}"), KeyEpoch: 1}
		if err := repo.CreateMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.ExecContext(ctx, `UPDATE group_dm_messages SET created_at=? WHERE id=?`, created, id); err != nil {
			t.Fatal(err)
		}
	}
	create("group-before", dmAlice, "2026-01-01 10:00:00")
	create("group-incoming-before", dmBob, "2026-01-01 10:00:01")
	create("group-cursor", dmAlice, "2026-01-01 10:00:02")
	create("group-incoming-first", dmBob, "2026-01-01 10:00:03")
	create("group-own-after", dmAlice, "2026-01-01 10:00:04")
	create("group-incoming-second", dmBob, "2026-01-01 10:00:05")
	if _, err := db.Conn.ExecContext(ctx, `UPDATE group_dm_reads SET last_read_message_id=?,unread_count=2 WHERE group_id=? AND user_id=?`, "group-cursor", groupID, dmAlice); err != nil {
		t.Fatal(err)
	}
	state, err := repo.GetReadState(ctx, groupID, dmAlice)
	if err != nil || state.UnreadCount != 2 || state.OldestUnreadMessageID == nil || *state.OldestUnreadMessageID != "group-incoming-first" {
		t.Fatalf("read summary=%+v err=%v", state, err)
	}
	if err := repo.DeleteMessage(ctx, groupID, "group-cursor", dmAlice); err != nil {
		t.Fatal(err)
	}
	state, err = repo.GetReadState(ctx, groupID, dmAlice)
	if err != nil || state.UnreadCount != 2 || state.OldestUnreadMessageID == nil || *state.OldestUnreadMessageID != "group-incoming-first" {
		t.Fatalf("deleted cursor summary=%+v err=%v", state, err)
	}
	if err := repo.DeleteMessage(ctx, groupID, "group-incoming-first", dmBob); err != nil {
		t.Fatal(err)
	}
	state, err = repo.GetReadState(ctx, groupID, dmAlice)
	if err != nil || state.UnreadCount != 1 || state.OldestUnreadMessageID == nil || *state.OldestUnreadMessageID != "group-incoming-second" {
		t.Fatalf("unread deletion summary=%+v err=%v", state, err)
	}
	if err := repo.MarkRead(ctx, groupID, dmAlice, nil); err != nil {
		t.Fatal(err)
	}
	state, err = repo.GetReadState(ctx, groupID, dmAlice)
	if err != nil || state.UnreadCount != 0 || state.OldestUnreadMessageID != nil {
		t.Fatalf("read group still exposed anchor: %+v err=%v", state, err)
	}
}

func groupAnchorString(value string) *string { return &value }

func TestGroupDMGetMessagesAroundIsBoundedScopedAndOrdered(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	for _, groupID := range []string{"around-group", "other-around-group"} {
		if err := repo.Create(ctx, &models.GroupDM{ID: groupID, OwnerID: dmAlice, Name: groupID, KeyEpoch: 1, CallRoomKey: groupID + "-room"}, []string{dmAlice, dmBob}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 9; i++ {
		id := fmt.Sprintf("around-%02d", i)
		message := &models.GroupDMMessage{ID: id, GroupID: "around-group", UserID: dmAlice, EncryptionVersion: 1, Ciphertext: groupAnchorString("cipher"), SenderDeviceID: groupAnchorString("device"), E2EEMetadata: groupAnchorString("{}"), KeyEpoch: 7}
		if err := repo.CreateMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.ExecContext(ctx, `UPDATE group_dm_messages SET created_at=? WHERE id=?`, fmt.Sprintf("2026-01-01 10:00:%02d", i), id); err != nil {
			t.Fatal(err)
		}
	}
	page, hasBefore, hasAfter, err := repo.GetMessagesAround(ctx, "around-group", "around-04", 5)
	if err != nil {
		t.Fatal(err)
	}
	if !hasBefore || !hasAfter || len(page) != 5 {
		t.Fatalf("window len=%d hasBefore=%t hasAfter=%t", len(page), hasBefore, hasAfter)
	}
	for i, message := range page {
		want := fmt.Sprintf("around-%02d", i+2)
		if message.ID != want || message.KeyEpoch != 7 || message.Ciphertext == nil || *message.Ciphertext != "cipher" {
			t.Fatalf("window[%d]=%+v, want id=%s and encrypted key metadata preserved", i, message, want)
		}
	}
	evenPage, _, _, err := repo.GetMessagesAround(ctx, "around-group", "around-04", 4)
	if err != nil || len(evenPage) != 4 {
		t.Fatalf("even bounded window len=%d err=%v, want exactly 4", len(evenPage), err)
	}
	if _, _, _, err := repo.GetMessagesAround(ctx, "other-around-group", "around-04", 5); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-group anchor err=%v, want not found", err)
	}
}
