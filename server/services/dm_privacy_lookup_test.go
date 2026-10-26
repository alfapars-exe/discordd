package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestSendMessage_RecipientPrivacyLookupFailsClosed(t *testing.T) {
	lookupErr := errors.New("recipient lookup unavailable")
	for _, tc := range []struct {
		name string
		err  error
		want error
	}{
		{name: "lookup error", err: lookupErr, want: lookupErr},
		{name: "missing recipient", want: pkg.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newDMFixture()
			f.repo.GetChannelByIDFn = func(context.Context, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "ch-1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
			}
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
				if id == "bob" {
					return nil, tc.err
				}
				return &models.User{ID: id}, nil
			}
			f.repo.CreateMessageFn = func(context.Context, *models.DMMessage) error {
				t.Fatal("message persisted without resolving recipient privacy")
				return nil
			}
			_, err := f.svc.SendMessage(context.Background(), "alice", "ch-1", &models.CreateDMMessageRequest{Content: "hello"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("SendMessage error = %v, want %v", err, tc.want)
			}
		})
	}
}
