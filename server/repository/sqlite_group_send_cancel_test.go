package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMSendCancellationFencesDelayedAndConcurrentCommits(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('cancel-owner','cancel-owner','x')`); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, &models.GroupDM{ID: "cancel-group", OwnerID: "cancel-owner", Name: "Cancel", KeyEpoch: 1, CallRoomKey: "cancel-room"}, []string{"cancel-owner"}); err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	const delayed = "delayed-request-01"
	op, err := repo.CancelSend(ctx, "cancel-group", "cancel-owner", delayed)
	if err != nil || op.Phase != "cancelled" {
		t.Fatalf("cancelled=%+v err=%v", op, err)
	}
	// The request has not reached PrepareSend yet. A missing-row cancellation
	// must leave a tombstone rather than report success and forget the key.
	if _, _, err = repo.PrepareSend(ctx, "cancel-group", "cancel-owner", delayed, hash, 0); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("delayed preparation was not fenced", err)
	}
	if err = repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: delayed, GroupID: "cancel-group", UserID: "cancel-owner", KeyEpoch: 1}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("delayed message was not fenced", err)
	}
	repeated, err := repo.CancelSend(ctx, "cancel-group", "cancel-owner", delayed)
	if err != nil || repeated.Phase != "cancelled" || repeated.MessageID != op.MessageID {
		t.Fatalf("repeated=%+v err=%v", repeated, err)
	}
	for attempt := 0; attempt < 12; attempt++ {
		key := fmt.Sprintf("cancel-race-%05d", attempt)
		prepared, _, err := repo.PrepareSend(ctx, "cancel-group", "cancel-owner", key, hash, 0)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		committed := make(chan error, 1)
		cancelled := make(chan *models.GroupSendOperation, 1)
		cancelErrors := make(chan error, 1)
		go func() {
			<-start
			committed <- repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "cancel-group", UserID: "cancel-owner", KeyEpoch: 1})
		}()
		go func() {
			<-start
			out, err := repo.CancelSend(ctx, "cancel-group", "cancel-owner", key)
			cancelled <- out
			cancelErrors <- err
		}()
		close(start)
		writeErr, out, cancelErr := <-committed, <-cancelled, <-cancelErrors
		if cancelErr != nil {
			t.Fatal(cancelErr)
		}
		switch out.Phase {
		case "cancelled":
			if !errors.Is(writeErr, pkg.ErrConflict) {
				t.Fatalf("cancel won but message committed: %v", writeErr)
			}
			if _, err = repo.GetMessage(ctx, "cancel-group", prepared.MessageID); !errors.Is(err, pkg.ErrNotFound) {
				t.Fatal("cancelled message exists", err)
			}
		case "committed":
			if writeErr != nil {
				t.Fatal(writeErr)
			}
			if _, err = repo.GetMessage(ctx, "cancel-group", prepared.MessageID); err != nil {
				t.Fatal("cancellation removed committed message", err)
			}
			if _, err = repo.CompleteSend(ctx, "cancel-group", "cancel-owner", key, nil); err != nil {
				t.Fatal(err)
			}
			done, err := repo.CancelSend(ctx, "cancel-group", "cancel-owner", key)
			if err != nil || done.Phase != "completed" {
				t.Fatalf("completed operation cancelled: %+v %v", done, err)
			}
		default:
			t.Fatal("unexpected race outcome", out.Phase)
		}
	}
}
