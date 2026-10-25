package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type groupSendCommitFixture struct {
	repository.GroupDMRepository
	writes     int
	writeError error
}

func (f *groupSendCommitFixture) GetByID(context.Context, string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: "group", KeyEpoch: 1}, nil
}
func (f *groupSendCommitFixture) IsMember(context.Context, string, string) (bool, error) {
	return true, nil
}
func (f *groupSendCommitFixture) CreateMessage(_ context.Context, m *models.GroupDMMessage) error {
	f.writes++
	if f.writeError != nil {
		return f.writeError
	}
	m.ID = "committed"
	return nil
}

func TestGroupDMSendResolvesResponseBeforeCommit(t *testing.T) {
	for _, mode := range []string{"lookup failure", "commit failure", "success"} {
		t.Run(mode, func(t *testing.T) {
			f := &groupSendCommitFixture{}
			lookupError := errors.New("profile unavailable")
			commitError := errors.New("write unavailable")
			if mode == "commit failure" {
				f.writeError = commitError
			}
			lookups := 0
			users := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
				lookups++
				if f.writes != 0 {
					t.Fatal("profile lookup after message write")
				}
				if mode == "lookup failure" {
					return nil, lookupError
				}
				return &models.User{ID: "sender", Username: "sender"}, nil
			}}
			svc := &groupDMService{groups: f, users: users}
			cipher, device := "encrypted", "device"
			m, err := svc.SendMessage(context.Background(), "group", "sender", &models.CreateGroupDMMessageRequest{Ciphertext: &cipher, SenderDeviceID: &device, KeyEpoch: 1})
			if lookups != 1 {
				t.Fatalf("lookups=%d", lookups)
			}
			switch mode {
			case "lookup failure":
				if !errors.Is(err, lookupError) || m != nil || f.writes != 0 {
					t.Fatalf("message=%+v err=%v writes=%d", m, err, f.writes)
				}
			case "commit failure":
				if !errors.Is(err, commitError) || m != nil || f.writes != 1 {
					t.Fatalf("message=%+v err=%v writes=%d", m, err, f.writes)
				}
			default:
				if err != nil || m == nil || m.ID != "committed" || m.User == nil || m.User.ID != "sender" || f.writes != 1 {
					t.Fatalf("message=%+v err=%v writes=%d", m, err, f.writes)
				}
			}
		})
	}
}
