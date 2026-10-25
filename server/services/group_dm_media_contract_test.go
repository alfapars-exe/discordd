package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

type groupMediaContractRepo struct {
	repository.GroupDMRepository
	epoch int64
	room  string
}

func (r *groupMediaContractRepo) GetByID(context.Context, string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: "group", KeyEpoch: r.epoch, CallRoomKey: r.room}, nil
}
func (r *groupMediaContractRepo) IsMember(_ context.Context, _, user string) (bool, error) {
	return user == "member", nil
}
func TestGroupDMCallMediaKeyContract(t *testing.T) {
	repo := &groupMediaContractRepo{epoch: 256, room: "room"}
	svc := &groupDMService{groups: repo, users: &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
		return &models.User{ID: "member", Username: "Member"}, nil
	}}, liveKitURL: "wss://local.invalid", liveKitAPIKey: "local-key", liveKitAPISecret: "local-secret", mediaKey: []byte("local-media-key")}
	ctx := context.Background()
	initial, err := svc.GenerateCallToken(ctx, "group", "member")
	if err != nil {
		t.Fatal(err)
	}
	if initial.E2EEKeyEpoch != 256 || initial.E2EEKeyIndex != 0 || initial.E2EEKeyContext == "" || initial.E2EEPassphrase == "" {
		t.Fatal("missing authoritative media key contract")
	}
	repo.epoch = 512
	next, err := svc.GenerateCallToken(ctx, "group", "member")
	if err != nil {
		t.Fatal(err)
	}
	if next.E2EEKeyEpoch != 512 || next.E2EEKeyIndex != 0 || next.E2EEKeyContext != initial.E2EEKeyContext || next.E2EEPassphrase == initial.E2EEPassphrase {
		t.Fatal("media passphrase is not bound to exact full group epoch")
	}
	repo.room = "new-room"
	recreated, err := svc.GenerateCallToken(ctx, "group", "member")
	if err != nil {
		t.Fatal(err)
	}
	if recreated.E2EEKeyContext == initial.E2EEKeyContext {
		t.Fatal("new call room retained old context")
	}
	if _, err = svc.GenerateCallToken(ctx, "group", "outsider"); err == nil {
		t.Fatal("outsider obtained media key")
	}
	for _, epoch := range []int64{-1, 9007199254740992} {
		repo.epoch = epoch
		if _, err = svc.GenerateCallToken(ctx, "group", "member"); err == nil {
			t.Fatal("non-safe media epoch accepted")
		}
	}
}
