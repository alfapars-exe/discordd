package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupSourceOrderSameSecondWarmupLowerIDsAndDeletedWatermark(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	id := "group-source-order"
	if err := repo.Create(ctx, &models.GroupDM{ID: id, OwnerID: dmAlice, Name: id, KeyEpoch: 1, CallRoomKey: id}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	create := func(messageID string) *models.GroupDMMessage {
		t.Helper()
		cipher, device := "cipher", "device"
		m := &models.GroupDMMessage{ID: messageID, GroupID: id, UserID: dmAlice, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1}
		if err := repo.CreateMessage(ctx, m); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET created_at='2026-01-01 00:00:00' WHERE id=?`, m.ID); err != nil {
			t.Fatal(err)
		}
		return m
	}
	warmup := create("zz-warmup")
	if err := repo.MarkRead(ctx, id, dmBob, nil); err != nil {
		t.Fatal(err)
	}
	first, second, third := create("aa-new"), create("bb-new"), create("cc-new")
	if warmup.SourceSequence != 1 || first.SourceSequence != 2 || third.SourceSequence != 4 {
		t.Fatalf("source order=%d,%d,%d", warmup.SourceSequence, first.SourceSequence, third.SourceSequence)
	}
	if err := repo.MarkRead(ctx, id, dmBob, &first.ID); err != nil {
		t.Fatal(err)
	}
	read, err := repo.GetReadState(ctx, id, dmBob)
	if err != nil || read.UnreadCount != 2 || read.LastReadSourceSequence != 2 || read.OldestUnreadMessageID == nil || *read.OldestUnreadMessageID != second.ID {
		t.Fatalf("same-second read=%+v err=%v", read, err)
	}
	page, err := repo.ListMessages(ctx, id, "", 2)
	if err != nil || len(page) != 2 || page[0].ID != third.ID || page[1].ID != second.ID {
		t.Fatalf("tail=%+v err=%v", page, err)
	}
	page, err = repo.ListMessages(ctx, id, second.ID, 2)
	if err != nil || len(page) != 2 || page[0].ID != first.ID || page[1].ID != warmup.ID {
		t.Fatalf("history=%+v err=%v", page, err)
	}
	around, older, newer, err := repo.GetMessagesAround(ctx, id, first.ID, 3)
	ids := []string{}
	for _, m := range around {
		ids = append(ids, m.ID)
	}
	if err != nil || !reflect.DeepEqual(ids, []string{warmup.ID, first.ID, second.ID}) || older || !newer {
		t.Fatalf("around=%v older=%v newer=%v err=%v", ids, older, newer, err)
	}
	if err := repo.DeleteMessage(ctx, id, first.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	read, err = repo.GetReadState(ctx, id, dmBob)
	if err != nil || read.LastReadSourceSequence != 2 || read.UnreadCount != 2 {
		t.Fatalf("deleted cursor moved watermark=%+v err=%v", read, err)
	}
	if err := repo.MarkRead(ctx, id, dmBob, nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteMessage(ctx, id, third.ID, dmAlice); err != nil {
		t.Fatal(err)
	}
	next := create("00-after-tail-delete")
	if next.SourceSequence != 5 {
		t.Fatalf("deleted source sequence reused=%d", next.SourceSequence)
	}
	read, err = repo.GetReadState(ctx, id, dmBob)
	if err != nil || read.LastReadSourceSequence != 4 || read.UnreadCount != 1 || read.OldestUnreadMessageID == nil || *read.OldestUnreadMessageID != next.ID {
		t.Fatalf("new arrival after deleted tail=%+v err=%v", read, err)
	}
	rewind, err := repo.MarkUnreadFrom(ctx, id, dmBob, second.ID)
	if err != nil || rewind.LastReadSourceSequence != 2 || rewind.UnreadCount != 2 {
		t.Fatalf("rewind crossed deleted source gap=%+v err=%v", rewind, err)
	}
}

func TestGroupSourceScopeRejectsOldMembershipReadUnreadAndMuteIntent(t *testing.T) {
	repo, id := groupSettingsFixture(t)
	ctx := context.Background()
	cipher, device := "cipher", "device"
	message := &models.GroupDMMessage{ID: "before-rejoin", GroupID: id, UserID: dmAlice, KeyEpoch: 1, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device}
	if err := repo.CreateMessage(ctx, message); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetMuted(ctx, id, dmBob, true, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RemoveMember(ctx, id, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMember(ctx, id, dmBob); err != nil {
		t.Fatal(err)
	}
	before, err := repo.GetReadState(ctx, id, dmBob)
	if err != nil {
		t.Fatal(err)
	}
	if before.KeyEpoch != 3 || before.LastReadSourceSequence != message.SourceSequence || before.IsMuted || before.UnreadCount != 0 {
		t.Fatalf("new membership baseline=%+v", before)
	}
	if err := repo.MarkRead(ctx, id, dmBob, nil, 1); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("old read intent=%v", err)
	}
	if _, err := repo.MarkUnreadFrom(ctx, id, dmBob, message.ID, 1); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("old unread intent=%v", err)
	}
	if _, err := repo.SetMuted(ctx, id, dmBob, true, 1); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("old mute intent=%v", err)
	}
	after, err := repo.GetReadState(ctx, id, dmBob)
	if err != nil || after.Revision != before.Revision || after.SettingsRevision != before.SettingsRevision || after.IsMuted || after.UnreadCount != 0 {
		t.Fatalf("old intent changed new member=%+v err=%v", after, err)
	}
	fresh, err := repo.SetMuted(ctx, id, dmBob, true, 3)
	if err != nil || !fresh.IsMuted || fresh.KeyEpoch != 3 {
		t.Fatalf("fresh intent=%+v err=%v", fresh, err)
	}
	// Legacy callers remain current-member scoped, but cannot identify an old intent.
	if _, err := repo.SetMuted(ctx, id, dmBob, false); err != nil {
		t.Fatalf("legacy call shape broken: %v", err)
	}
}

func TestGroupSourceOrderPositiveImportAndJoinRejoinBaseline(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	id := "group-source-import"
	if err := repo.Create(ctx, &models.GroupDM{ID: id, OwnerID: dmAlice, Name: id, KeyEpoch: 1, CallRoomKey: id}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	const high int64 = 9007199254740993
	for _, row := range []struct {
		id  string
		seq int64
	}{{"import-high", high}, {"import-low", 7}} {
		if _, err := db.Conn.Exec(`INSERT INTO group_dm_messages(id,group_id,user_id,encryption_version,ciphertext,sender_device_id,key_epoch,source_sequence) VALUES(?,?,?,1,'cipher','device',1,?)`, row.id, id, dmAlice, row.seq); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET source_sequence=8 WHERE id='import-low'`); err == nil {
		t.Fatal("positive imported sequence was mutable")
	}
	if _, err := repo.AddMember(ctx, id, dmCarol); err != nil {
		t.Fatal(err)
	}
	joined, err := repo.GetReadState(ctx, id, dmCarol)
	if err != nil || joined.LastReadSourceSequence != high || joined.UnreadCount != 0 || joined.KeyEpoch != 2 {
		t.Fatalf("join baseline=%+v err=%v", joined, err)
	}
	cipher, device := "cipher", "device"
	next := &models.GroupDMMessage{ID: "new-after-join", GroupID: id, UserID: dmAlice, KeyEpoch: 2, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device}
	if err := repo.CreateMessage(ctx, next); err != nil {
		t.Fatal(err)
	}
	if next.SourceSequence != high+1 {
		t.Fatalf("import counter overwritten=%d", next.SourceSequence)
	}
	joined, err = repo.GetReadState(ctx, id, dmCarol)
	if err != nil || joined.UnreadCount != 1 {
		t.Fatalf("old history became unread=%+v err=%v", joined, err)
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		t.Fatal(err)
	}
	var public map[string]any
	if err := json.Unmarshal(encoded, &public); err != nil {
		t.Fatal(err)
	}
	if public["source_sequence"] != "9007199254740994" {
		t.Fatalf("public source lost decimal precision=%v", public["source_sequence"])
	}
	if _, err := repo.RemoveMember(ctx, id, dmCarol); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMember(ctx, id, dmCarol); err != nil {
		t.Fatal(err)
	}
	rejoined, err := repo.GetReadState(ctx, id, dmCarol)
	if err != nil || rejoined.LastReadSourceSequence != high+1 || rejoined.UnreadCount != 0 || rejoined.KeyEpoch != 4 {
		t.Fatalf("rejoin baseline=%+v err=%v", rejoined, err)
	}
	next.ID = "new-after-rejoin"
	next.SourceSequence = 0
	next.KeyEpoch = 4
	if err := repo.CreateMessage(ctx, next); err != nil {
		t.Fatal(err)
	}
	rejoined, err = repo.GetReadState(ctx, id, dmCarol)
	if err != nil || rejoined.UnreadCount != 1 || rejoined.LastReadSourceSequence != high+1 {
		t.Fatalf("rejoin first new message=%+v err=%v", rejoined, err)
	}
}
