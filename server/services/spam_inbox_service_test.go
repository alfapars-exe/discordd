package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

type spamStoreStub struct {
	writes int
	owner  string
}

func (s *spamStoreStub) Decisions(context.Context, string, string, int) (*models.SpamInboxPage, error) {
	return &models.SpamInboxPage{Entries: []models.SpamInboxEntry{}}, nil
}

func (s *spamStoreStub) Page(context.Context, string, string, int) (*models.SpamInboxPage, error) {
	return &models.SpamInboxPage{Entries: []models.SpamInboxEntry{}}, nil
}

func (s *spamStoreStub) Record(_ context.Context, e *models.SpamInboxEntry) error {
	s.writes++
	s.owner = e.UserID
	return nil
}
func (s *spamStoreStub) Decide(_ context.Context, userID, kind, id, revision, status string) (bool, error) {
	s.owner = userID
	return true, nil
}
func (s *spamStoreStub) List(context.Context, string, int) ([]models.SpamInboxEntry, error) {
	return []models.SpamInboxEntry{}, nil
}

func TestSpamInboxDMSourceAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, user, channel, revision string
		want                          error
	}{
		{"recipient", "recipient", "private", "original", nil},
		{"foreign member", "stranger", "private", "original", pkg.ErrNotFound},
		{"wrong channel", "recipient", "wrong", "original", pkg.ErrNotFound},
		{"own message", "sender", "private", "original", pkg.ErrBadRequest},
		{"stale revision", "recipient", "private", "2026-10-24T12:00:00Z", pkg.ErrConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &spamStoreStub{}
			dms := &testutil.MockDMRepo{
				GetMessageByIDFn: func(context.Context, string) (*models.DMMessage, error) {
					return &models.DMMessage{ID: "message", DMChannelID: "private", UserID: "sender"}, nil
				},
				GetChannelByIDFn: func(context.Context, string) (*models.DMChannel, error) {
					return &models.DMChannel{ID: "private", User1ID: "sender", User2ID: "recipient"}, nil
				},
			}
			svc := NewSpamInboxService(store, nil, nil, dms, nil, nil)
			entry := &models.SpamInboxEntry{UserID: "forged-owner", SourceKind: "dm", ChannelID: tc.channel, MessageID: "message", Revision: tc.revision, Reasons: []string{"credential-link"}}
			err := svc.Record(context.Background(), tc.user, entry)
			if !errors.Is(err, tc.want) {
				t.Fatalf("error=%v want=%v", err, tc.want)
			}
			if tc.want != nil && store.writes != 0 {
				t.Fatal("unauthorized record written")
			}
			if tc.want == nil && (store.writes != 1 || store.owner != "recipient") {
				t.Fatal("authenticated owner not enforced")
			}
		})
	}
}
