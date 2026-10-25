package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMDurableSendLifecycle(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('op-owner','op-owner','x'),('op-reader','op-reader','x')`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "op-group", OwnerID: "op-owner", Name: "Operation", KeyEpoch: 1, CallRoomKey: "op-room"}, []string{"op-owner", "op-reader"}); err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	key := "request-00000001"
	op, acquired, err := repo.PrepareSend(ctx, "op-group", "op-owner", key, hash, 2)
	if err != nil || !acquired || op.Phase != "prepared" {
		t.Fatalf("op=%+v acquired=%v err=%v", op, acquired, err)
	}
	repeat, acquired, err := repo.PrepareSend(ctx, "op-group", "op-owner", key, hash, 2)
	if err != nil || acquired || repeat.MessageID != op.MessageID {
		t.Fatalf("repeat=%+v acquired=%v err=%v", repeat, acquired, err)
	}
	if _, _, err = repo.PrepareSend(ctx, "op-group", "op-owner", key, strings.Repeat("b", 64), 2); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal(err)
	}
	if _, _, err = repo.PrepareSend(ctx, "op-group", "op-owner", key, hash, 1); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal(err)
	}
	if _, err = repo.GetSendOperation(ctx, "op-group", "op-reader", key); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal("other user sees operation", err)
	}
	if _, _, err = repo.PrepareSend(ctx, "op-group", "op-owner", "invalid", hash, 0); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatal(err)
	}
	if _, err = repo.CompleteSend(ctx, "op-group", "op-owner", key, []int{0, 1}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("uncommitted operation finalized", err)
	}
	cipher, device := "cipher", "device"
	message := &models.GroupDMMessage{GroupID: "op-group", UserID: "op-owner", SendRequestID: key, Ciphertext: &cipher, SenderDeviceID: &device, EncryptionVersion: 1, KeyEpoch: 1}
	if err = repo.CreateMessage(ctx, message); err != nil || message.ID != op.MessageID {
		t.Fatalf("message=%+v err=%v", message, err)
	}
	if err = repo.CreateMessage(ctx, message); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("message replay was not fenced", err)
	}
	read, err := repo.GetReadState(ctx, "op-group", "op-reader")
	if err != nil || read.UnreadCount != 1 || read.Revision != 1 {
		t.Fatalf("duplicate read increment: %+v %v", read, err)
	}
	// A reconstructed repository (no in-memory claim) sees the committed state.
	reopened := NewSQLiteGroupDMRepo(wrapForRepo(db))
	stored, err := reopened.GetSendOperation(ctx, "op-group", "op-owner", key)
	if err != nil || stored.Phase != "committed" {
		t.Fatalf("stored=%+v err=%v", stored, err)
	}
	if _, err = repo.CompleteSend(ctx, "op-group", "op-owner", key, nil); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("incomplete upload classified success", err)
	}
	one := 1
	attachment := &models.GroupDMAttachment{ID: "op-file", GroupMessageID: message.ID, Filename: "encrypted_1.bin", FileURL: "/api/uploads/op-file", FileKeyIndex: &one}
	if err = repo.CreateAttachment(ctx, attachment); err != nil {
		t.Fatal(err)
	}
	duplicate := *attachment
	duplicate.ID = "duplicate"
	duplicate.FileURL = "/api/uploads/duplicate"
	if err = repo.CreateAttachment(ctx, &duplicate); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("duplicate file position", err)
	}
	for _, failed := range [][]int{nil, {1}, {0, 0}, {2}} {
		if _, err = repo.CompleteSend(ctx, "op-group", "op-owner", key, failed); err == nil {
			t.Fatalf("invalid outcome accepted: %v", failed)
		}
	}
	done, err := repo.CompleteSend(ctx, "op-group", "op-owner", key, []int{0})
	if err != nil || done.Phase != "completed" || len(done.FailedIndices) != 1 || done.FailedIndices[0] != 0 {
		t.Fatalf("done=%+v err=%v", done, err)
	}
	if _, err = reopened.CompleteSend(ctx, "op-group", "op-owner", key, []int{0}); err != nil {
		t.Fatal("identical outcome replay", err)
	}
	if _, err = repo.CompleteSend(ctx, "op-group", "op-owner", key, []int{1}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal(err)
	}
	zero := 0
	late := *attachment
	late.ID = "late"
	late.FileKeyIndex = &zero
	late.FileURL = "/api/uploads/late"
	if err = repo.CreateAttachment(ctx, &late); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("late upload changed completed outcome", err)
	}
	if err = repo.DeleteMessage(ctx, "op-group", message.ID, "op-owner"); err != nil {
		t.Fatal(err)
	}
	deleted, err := reopened.GetSendOperation(ctx, "op-group", "op-owner", key)
	if err != nil || deleted.Phase != "deleted" {
		t.Fatalf("deleted=%+v err=%v", deleted, err)
	}
	if err = repo.CreateMessage(ctx, message); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("deleted message resurrected", err)
	}
}

func TestGroupDMDurableSendConcurrentPrepareAndCommit(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('race-owner','race-owner','x')`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "race-group", OwnerID: "race-owner", Name: "Race", KeyEpoch: 1, CallRoomKey: "race-room"}, []string{"race-owner"}); err != nil {
		t.Fatal(err)
	}
	const key = "race-request-0001"
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	errs := make(chan error, 8)
	claimed := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			op, acquired, err := repo.PrepareSend(ctx, "race-group", "race-owner", key, strings.Repeat("c", 64), 0)
			if err != nil {
				errs <- err
				return
			}
			ids <- op.MessageID
			claimed <- acquired
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	close(claimed)
	for err := range errs {
		t.Error(err)
	}
	id := ""
	for next := range ids {
		if id != "" && id != next {
			t.Fatal("different reserved IDs")
		}
		id = next
	}
	owners := 0
	for acquired := range claimed {
		if acquired {
			owners++
		}
	}
	if owners != 1 {
		t.Fatalf("claim owners=%d", owners)
	}
	commits := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			commits <- repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "race-group", UserID: "race-owner", KeyEpoch: 1})
		}()
	}
	wg.Wait()
	close(commits)
	successes := 0
	for err := range commits {
		if err == nil {
			successes++
		} else if !errors.Is(err, pkg.ErrConflict) {
			t.Error(err)
		}
	}
	if successes != 1 {
		t.Fatalf("message commits=%d", successes)
	}
	if _, err := repo.CompleteSend(ctx, "race-group", "race-owner", key, nil); err != nil {
		t.Fatal(err)
	}
}

func TestGroupDMDurableSendFinalizationFencesLateUploads(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('fence-owner','fence-owner','x')`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "fence-group", OwnerID: "fence-owner", Name: "Fence", KeyEpoch: 1, CallRoomKey: "fence-room"}, []string{"fence-owner"}); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 10; attempt++ {
		key := fmt.Sprintf("fenced-request-%04d", attempt)
		op, _, err := repo.PrepareSend(ctx, "fence-group", "fence-owner", key, strings.Repeat("d", 64), 1)
		if err != nil {
			t.Fatal(err)
		}
		if err = repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "fence-group", UserID: "fence-owner", KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
		zero := 0
		start := make(chan struct{})
		upload := make(chan error, 1)
		complete := make(chan error, 1)
		go func() {
			<-start
			upload <- repo.CreateAttachment(ctx, &models.GroupDMAttachment{GroupMessageID: op.MessageID, Filename: "encrypted_0.bin", FileURL: "/api/uploads/" + key, FileKeyIndex: &zero})
		}()
		go func() {
			<-start
			_, err := repo.CompleteSend(ctx, "fence-group", "fence-owner", key, []int{0})
			complete <- err
		}()
		close(start)
		uploadErr, completeErr := <-upload, <-complete
		switch {
		case uploadErr == nil:
			if !errors.Is(completeErr, pkg.ErrConflict) {
				t.Fatalf("uploaded file also classified failed: %v", completeErr)
			}
			if _, err = repo.CompleteSend(ctx, "fence-group", "fence-owner", key, nil); err != nil {
				t.Fatal(err)
			}
		case completeErr == nil:
			if !errors.Is(uploadErr, pkg.ErrConflict) {
				t.Fatalf("late upload not fenced: %v", uploadErr)
			}
		default:
			t.Fatalf("both racing operations failed: upload=%v complete=%v", uploadErr, completeErr)
		}
		stored, err := repo.GetSendOperation(ctx, "fence-group", "fence-owner", key)
		if err != nil || stored.Phase != "completed" {
			t.Fatalf("outcome=%+v err=%v", stored, err)
		}
	}
}

func TestGroupDMDurableSendStaleEpochRollsBackOperation(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('epoch-owner','epoch-owner','x')`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "epoch-group", OwnerID: "epoch-owner", Name: "Epoch", KeyEpoch: 2, CallRoomKey: "epoch-room"}, []string{"epoch-owner"}); err != nil {
		t.Fatal(err)
	}
	const key = "epoch-request-0001"
	if _, _, err := repo.PrepareSend(ctx, "epoch-group", "epoch-owner", key, strings.Repeat("e", 64), 0); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "epoch-group", UserID: "epoch-owner", KeyEpoch: 1}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal(err)
	}
	op, err := repo.GetSendOperation(ctx, "epoch-group", "epoch-owner", key)
	if err != nil || op.Phase != "prepared" {
		t.Fatalf("failed epoch consumed operation: %+v %v", op, err)
	}
	if _, err = repo.GetMessage(ctx, "epoch-group", op.MessageID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal("stale message persisted", err)
	}
}
