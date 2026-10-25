package repository

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func groupSettingsFixture(t *testing.T) (GroupDMRepository, string) {
	t.Helper()
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	id := "private-settings-group"
	if err := repo.Create(context.Background(), &models.GroupDM{ID: id, OwnerID: dmAlice, Name: "Settings", KeyEpoch: 1, CallRoomKey: "private-settings-room"}, []string{dmAlice, dmBob}); err != nil {
		t.Fatal(err)
	}
	return repo, id
}

func TestGroupDMSettingsArePrivateIdempotentAndMembershipScoped(t *testing.T) {
	repo, id := groupSettingsFixture(t)
	ctx := context.Background()
	state, err := repo.SetMuted(ctx, id, dmBob, true)
	if err != nil || !state.IsMuted || state.SettingsRevision != 1 || state.Revision != 0 || state.UnreadCount != 0 {
		t.Fatalf("mute=%+v err=%v", state, err)
	}
	state, err = repo.SetMuted(ctx, id, dmBob, true)
	if err != nil || state.SettingsRevision != 1 {
		t.Fatalf("retry changed revision=%+v err=%v", state, err)
	}
	own, err := repo.GetReadState(ctx, id, dmAlice)
	if err != nil || own.IsMuted || own.SettingsRevision != 0 {
		t.Fatalf("another member inherited private setting=%+v err=%v", own, err)
	}
	if _, err := repo.SetMuted(ctx, id, dmCarol, true); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("outsider mute=%v", err)
	}
	g, err := repo.GetByID(ctx, id)
	if err != nil || g.KeyEpoch != 1 || g.IsMuted || g.SettingsRevision != 0 {
		t.Fatalf("setting changed/leaked shared group=%+v err=%v", g, err)
	}
	if _, err := repo.RemoveMember(ctx, id, dmBob); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetMuted(ctx, id, dmBob, false); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("removed member mute=%v", err)
	}
	if _, err := repo.AddMember(ctx, id, dmBob); err != nil {
		t.Fatal(err)
	}
	state, err = repo.GetReadState(ctx, id, dmBob)
	if err != nil || state.IsMuted || state.SettingsRevision != 0 {
		t.Fatalf("new membership inherited retired settings=%+v err=%v", state, err)
	}
}

func TestGroupDMLegacySendCannotCommitAfterMembershipOrEpochChanged(t *testing.T) {
	repo, id := groupSettingsFixture(t)
	ctx := context.Background()
	cipher, device := "cipher", "sender-device"
	if _, err := repo.AddMember(ctx, id, dmCarol); err != nil {
		t.Fatal(err)
	}
	message := &models.GroupDMMessage{ID: "stale-legacy", GroupID: id, UserID: dmBob, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1}
	if err := repo.CreateMessage(ctx, message); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("legacy stale epoch was not refused: %v", err)
	}
	message.KeyEpoch = 2
	if err := repo.CreateMessage(ctx, message); err != nil {
		t.Fatalf("fresh legacy send failed: %v", err)
	}
	if _, err := repo.RemoveMember(ctx, id, dmBob); err != nil {
		t.Fatal(err)
	}
	message.ID = "retired-legacy"
	message.KeyEpoch = 3
	if err := repo.CreateMessage(ctx, message); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("retired member committed legacy send: %v", err)
	}
}

func TestGroupDMConcurrentSendReadMembershipAndPrivateSettingsStayConsistent(t *testing.T) {
	repo, id := groupSettingsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	failures := make(chan error, 14)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			cipher, device := "cipher", "sender-device"
			err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: fmt.Sprintf("parallel-%02d", index), GroupID: id, UserID: dmAlice, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1})
			if err != nil && !errors.Is(err, pkg.ErrConflict) {
				failures <- err
			}
		}(i)
	}
	wg.Add(3)
	go func() {
		defer wg.Done()
		if err := repo.MarkRead(ctx, id, dmBob, nil); err != nil {
			failures <- err
		}
	}()
	go func() {
		defer wg.Done()
		if _, err := repo.SetMuted(ctx, id, dmBob, true); err != nil {
			failures <- err
		}
	}()
	go func() {
		defer wg.Done()
		if _, err := repo.AddMember(ctx, id, dmCarol); err != nil {
			failures <- err
		}
	}()
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	bob, err := repo.GetReadState(ctx, id, dmBob)
	if err != nil || !bob.IsMuted || bob.UnreadCount < 0 || bob.SettingsRevision != 1 {
		t.Fatalf("inconsistent reader=%+v err=%v", bob, err)
	}
	g, err := repo.GetByID(ctx, id)
	if err != nil || g.KeyEpoch != 2 {
		t.Fatalf("membership epoch=%+v err=%v", g, err)
	}
	if err := repo.MarkRead(ctx, id, dmBob, nil); err != nil {
		t.Fatal(err)
	}
	bob, err = repo.GetReadState(ctx, id, dmBob)
	if err != nil || bob.UnreadCount != 0 || !bob.IsMuted {
		t.Fatalf("final read lost own settings=%+v err=%v", bob, err)
	}
}
