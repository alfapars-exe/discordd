package repository

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMReadCursorRewindAndRevision(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('sender','sender','x'),('reader','reader','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	for _, id := range []string{"read-group", "foreign-group"} {
		if err := repo.Create(ctx, &models.GroupDM{ID: id, OwnerID: "sender", Name: id, KeyEpoch: 1, CallRoomKey: "room-" + id}, []string{"sender", "reader"}); err != nil {
			t.Fatal(err)
		}
	}
	cipher, device, meta := "cipher", "device", "{}"
	for _, item := range []struct{ id, author, group string }{{"m1", "sender", "read-group"}, {"m2", "sender", "read-group"}, {"m3", "reader", "read-group"}, {"m4", "sender", "read-group"}, {"other", "sender", "foreign-group"}} {
		if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: item.id, GroupID: item.group, UserID: item.author, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET created_at=? WHERE id=?`, "2026-01-01 10:00:00", item.id); err != nil {
			t.Fatal(err)
		}
	}
	anchor := "m1"
	if err := repo.MarkRead(ctx, "read-group", "reader", &anchor); err != nil {
		t.Fatal(err)
	}
	read, err := repo.GetReadState(ctx, "read-group", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if read.UnreadCount != 1 || read.LastReadMessageID == nil || *read.LastReadMessageID != "m3" {
		t.Fatalf("old acknowledgement regressed the already-read own source: %+v", read)
	}
	unread, err := repo.MarkUnreadFrom(ctx, "read-group", "reader", "m2")
	if err != nil {
		t.Fatal(err)
	}
	if unread.UnreadCount != 2 || unread.Revision <= read.Revision || unread.LastReadMessageID == nil || *unread.LastReadMessageID != "m1" {
		t.Fatalf("rewind=%+v previous=%+v", unread, read)
	}
	for _, args := range []struct{ group, user, message string }{{"read-group", "reader", "other"}, {"read-group", "outsider", "m2"}, {"read-group", "reader", "missing"}} {
		if _, err := repo.MarkUnreadFrom(ctx, args.group, args.user, args.message); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("cross-scope rewind returned %v", err)
		}
	}
	unchanged, _ := repo.GetReadState(ctx, "read-group", "reader")
	if unchanged.Revision != unread.Revision {
		t.Fatal("failed request changed revision")
	}
	if err := repo.MarkRead(ctx, "read-group", "reader", nil); err != nil {
		t.Fatal(err)
	}
	all, _ := repo.GetReadState(ctx, "read-group", "reader")
	if all.UnreadCount != 0 || all.LastReadMessageID == nil || *all.LastReadMessageID != "m4" {
		t.Fatalf("mark all=%+v", all)
	}
	first, err := repo.MarkUnreadFrom(ctx, "read-group", "reader", "m1")
	if err != nil {
		t.Fatal(err)
	}
	if first.LastReadMessageID != nil || first.UnreadCount != 3 {
		t.Fatalf("first boundary=%+v", first)
	}
	if err := repo.DeleteMessage(ctx, "read-group", "m1", "sender"); err != nil {
		t.Fatal(err)
	}
	deleted, _ := repo.GetReadState(ctx, "read-group", "reader")
	if deleted.UnreadCount != 2 || deleted.Revision <= first.Revision {
		t.Fatalf("deleted state=%+v", deleted)
	}
}

func TestGroupDMReadConcurrentSend(t *testing.T) {
	db := newTestDB(t)
	db.Conn.SetMaxOpenConns(8)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('sender','sender','x'),('reader','reader','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if err := repo.Create(ctx, &models.GroupDM{ID: "concurrent-read", OwnerID: "sender", Name: "Concurrent", KeyEpoch: 1, CallRoomKey: "concurrent-room"}, []string{"sender", "reader"}); err != nil {
		t.Fatal(err)
	}
	cipher, device, meta := "cipher", "device", "{}"
	create := func(id string) error {
		return repo.CreateMessage(ctx, &models.GroupDMMessage{ID: id, GroupID: "concurrent-read", UserID: "sender", EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1})
	}
	anchor := "c-000"
	if err := create(anchor); err != nil {
		t.Fatal(err)
	}
	if err := repo.MarkRead(ctx, "concurrent-read", "reader", &anchor); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	failures := make(chan error, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		<-start
		for i := 1; i <= 20; i++ {
			if err := create(fmt.Sprintf("c-%03d", i)); err != nil {
				failures <- err
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		<-start
		for i := 0; i < 20; i++ {
			if err := repo.MarkRead(ctx, "concurrent-read", "reader", &anchor); err != nil {
				failures <- err
				return
			}
		}
	}()
	close(start)
	wait.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	state, err := repo.GetReadState(ctx, "concurrent-read", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if state.UnreadCount != 20 || state.Revision != 42 {
		t.Fatalf("concurrent read/send lost count or revision: %+v", state)
	}
}
