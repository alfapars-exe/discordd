package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"sync"
	"testing"
)

func TestGroupPinsCapAtomicIdempotenceAndUnpin(t *testing.T) {
	db := newTestDB(t)
	db.Conn.SetMaxOpenConns(8)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('cap-owner','capowner','x')`); err != nil {
		t.Fatal(err)
	}
	r := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if err := r.Create(ctx, &models.GroupDM{ID: "cap-group", OwnerID: "cap-owner", Name: "Pins", KeyEpoch: 1, CallRoomKey: "cap-room"}, []string{"cap-owner"}); err != nil {
		t.Fatal(err)
	}
	cipher := "encrypted"
	for i := 0; i < MaxGroupDMPins+8; i++ {
		id := fmt.Sprintf("cap-%03d", i)
		if err := r.CreateMessage(ctx, &models.GroupDMMessage{ID: id, GroupID: "cap-group", UserID: "cap-owner", EncryptionVersion: 1, Ciphertext: &cipher, KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
		if i < MaxGroupDMPins-1 {
			if err := r.SetMessagePinned(ctx, "cap-group", id, "cap-owner", true); err != nil {
				t.Fatal(err)
			}
		}
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan error, 8)
	for i := MaxGroupDMPins - 1; i < MaxGroupDMPins+7; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			results <- r.SetMessagePinned(ctx, "cap-group", fmt.Sprintf("cap-%03d", i), "cap-owner", true)
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("concurrent pin: %v", err)
		}
	}
	if success != 1 {
		t.Fatalf("consumed final slot %d times", success)
	}
	items, err := r.ListPinnedMessages(ctx, "cap-group", "cap-owner")
	if err != nil || len(items) != MaxGroupDMPins {
		t.Fatalf("pins=%d err=%v", len(items), err)
	}
	if err = r.SetMessagePinned(ctx, "cap-group", "cap-000", "cap-owner", true); err != nil {
		t.Fatalf("idempotent pin at cap: %v", err)
	}
	extra := fmt.Sprintf("cap-%03d", MaxGroupDMPins+7)
	if err = r.SetMessagePinned(ctx, "cap-group", extra, "cap-owner", true); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("over cap: %v", err)
	}
	if err = r.SetMessagePinned(ctx, "cap-group", "cap-000", "cap-owner", false); err != nil {
		t.Fatal(err)
	}
	if err = r.SetMessagePinned(ctx, "cap-group", extra, "cap-owner", true); err != nil {
		t.Fatalf("freed slot not reused: %v", err)
	}
	// Listing must not silently truncate rows written by an older deployment.
	if _, err = db.Conn.Exec(`INSERT INTO group_dm_pins(group_id,message_id,pinned_by) VALUES('cap-group','cap-000','cap-owner')`); err != nil {
		t.Fatal(err)
	}
	items, err = r.ListPinnedMessages(ctx, "cap-group", "cap-owner")
	if err != nil || len(items) != MaxGroupDMPins+1 {
		t.Fatalf("legacy pins hidden: %d,%v", len(items), err)
	}
}

func TestGroupPinsPersistAndRequireCurrentMembership(t *testing.T) {
	db := newTestDB(t)
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('pin-owner','pinowner','x'),('pin-peer','pinpeer','x'),('pin-outsider','pinoutsider','x')`); err != nil {
		t.Fatal(err)
	}
	r := NewSQLiteGroupDMRepo(wrapForRepo(db))
	ctx := context.Background()
	for _, id := range []string{"pin-a", "pin-b"} {
		if err := r.Create(ctx, &models.GroupDM{ID: id, OwnerID: "pin-owner", Name: id, KeyEpoch: 1, CallRoomKey: id}, []string{"pin-owner", "pin-peer"}); err != nil {
			t.Fatal(err)
		}
	}
	cipher := "encrypted-private-payload"
	message := &models.GroupDMMessage{ID: "pin-message", GroupID: "pin-a", UserID: "pin-owner", EncryptionVersion: 1, Ciphertext: &cipher, KeyEpoch: 1}
	if err := r.CreateMessage(ctx, message); err != nil {
		t.Fatal(err)
	}
	if err := r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-outsider", true); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("outsider pin: %v", err)
	}
	if err := r.SetMessagePinned(ctx, "pin-b", message.ID, "pin-peer", true); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-group pin: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-peer", true); err != nil {
			t.Fatal(err)
		}
	}
	// A new repository instance observes durable state, with ciphertext intact.
	r = NewSQLiteGroupDMRepo(wrapForRepo(db))
	items, err := r.ListPinnedMessages(ctx, "pin-a", "pin-owner")
	if err != nil || len(items) != 1 || items[0].Ciphertext == nil || *items[0].Ciphertext != cipher || items[0].Content != nil {
		t.Fatalf("pins=%#v err=%v", items, err)
	}
	if _, err = r.RemoveMember(ctx, "pin-a", "pin-peer"); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ListPinnedMessages(ctx, "pin-a", "pin-peer"); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked list: %v", err)
	}
	if err = r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-peer", false); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked unpin: %v", err)
	}
	if err = r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-owner", false); err != nil {
		t.Fatal(err)
	}
	if err = r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-owner", false); err != nil {
		t.Fatalf("idempotent unpin: %v", err)
	}
	items, err = r.ListPinnedMessages(ctx, "pin-a", "pin-owner")
	if err != nil || len(items) != 0 {
		t.Fatalf("unpin=%#v,%v", items, err)
	}
	if err = r.SetMessagePinned(ctx, "pin-a", message.ID, "pin-owner", true); err != nil {
		t.Fatal(err)
	}
	if err = r.DeleteMessage(ctx, "pin-a", message.ID, "pin-owner"); err != nil {
		t.Fatal(err)
	}
	items, err = r.ListPinnedMessages(ctx, "pin-a", "pin-owner")
	if err != nil || len(items) != 0 {
		t.Fatalf("deleted pin=%#v,%v", items, err)
	}
}
