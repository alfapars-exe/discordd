package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"testing"
)

func TestSendMessageAcceptedRequestDoesNotRequireRecipientReply(t *testing.T) {
	for _, tc := range []struct {
		name             string
		initiator        *string
		privacy          string
		blocked, allowed bool
	}{
		{"accepted sender request", strPtr("alice"), "message_request", false, true},
		{"accepted opposite request", strPtr("bob"), "message_request", false, true},
		{"no acceptance marker", nil, "message_request", false, false},
		{"empty acceptance marker", strPtr(""), "message_request", false, false},
		{"foreign acceptance marker", strPtr("outsider"), "message_request", false, false},
		{"friends only still enforced", strPtr("alice"), "friends_only", false, false},
		{"block still enforced", strPtr("alice"), "message_request", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDMFixture()
			f.repo.GetChannelByIDFn = func(context.Context, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "ch-1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted, InitiatedBy: tc.initiator}, nil
			}
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, DMPrivacy: tc.privacy}, nil
			}
			f.friends.AreFriendsFn = func(context.Context, string, string) (bool, error) { return false, nil }
			f.block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return tc.blocked, nil }
			f.repo.CountMessagesBySenderFn = func(_ context.Context, _ string, sender string) (int, error) {
				if sender == "alice" {
					return 1, nil
				}
				return 0, nil
			}
			created := false
			f.repo.CreateMessageFn = func(context.Context, *models.DMMessage) error { created = true; return nil }
			_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "follow-up after acceptance"})
			if tc.allowed {
				if err != nil || !created {
					t.Fatalf("accepted request follow-up: created=%v err=%v", created, err)
				}
			} else if !errors.Is(err, pkg.ErrForbidden) || created {
				t.Fatalf("privacy gate: created=%v err=%v", created, err)
			}
		})
	}
}
