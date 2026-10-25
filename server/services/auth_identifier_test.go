package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func TestPasswordRecoveryIdentifierContracts(t *testing.T) {
	for _, tc := range []struct {
		name, identifier string
		email            *string
		found            bool
	}{
		{"username uses stored address", "  old-handle  ", strptr("stored@example.test"), true},
		{"legacy email-less account is silent", "legacy-handle", nil, true},
		{"blank legacy address is silent", "legacy-handle", strptr("  "), true},
		{"unknown username is silent", "unknown-handle", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			created, sent, lookedUp := 0, 0, ""
			users := &testutil.MockUserRepo{
				GetByEmailFn: func(context.Context, string) (*models.User, error) { return nil, pkg.ErrNotFound },
				GetByUsernameFn: func(_ context.Context, identifier string) (*models.User, error) {
					lookedUp = identifier
					if !tc.found {
						return nil, pkg.ErrNotFound
					}
					return &models.User{ID: "legacy-account", Email: tc.email}, nil
				},
			}
			reset := &testutil.MockResetRepo{
				GetLatestByUserIDFn: func(context.Context, string) (*models.PasswordResetToken, error) { return nil, pkg.ErrNotFound },
				CreateFn: func(_ context.Context, token *models.PasswordResetToken) error {
					created++
					if token.UserID != "legacy-account" || len(token.TokenHash) != 64 {
						t.Error("token must belong to the resolved user and store only its hash")
					}
					return nil
				},
			}
			sender := &testutil.MockEmailSender{SendPasswordResetFn: func(_ context.Context, address, token string) error {
				sent++
				if address != "stored@example.test" || len(token) != 64 {
					t.Error("recovery must use the stored address and a generated token")
				}
				return nil
			}}
			remaining, err := newAuthServiceForReset(users, reset, sender).ForgotPassword(context.Background(), tc.identifier)
			if err != nil || remaining != 0 {
				t.Fatalf("unexpected public outcome: %d, %v", remaining, err)
			}
			if lookedUp == "" || lookedUp[0] == ' ' {
				t.Fatal("identifier was not normalized before lookup")
			}
			want := 0
			if tc.name == "username uses stored address" {
				want = 1
			}
			if created != want || sent != want {
				t.Fatalf("unexpected recovery side effects: created=%d sent=%d", created, sent)
			}
		})
	}
}

func TestPasswordRecoveryDoesNotMaskRepositoryFailureWithUsernameLookup(t *testing.T) {
	failure := errors.New("controlled repository failure")
	users := &testutil.MockUserRepo{
		GetByEmailFn: func(context.Context, string) (*models.User, error) { return nil, failure },
		GetByUsernameFn: func(context.Context, string) (*models.User, error) {
			t.Fatal("database failure must not be converted into a username miss")
			return nil, nil
		},
	}
	_, err := newAuthServiceForReset(users, &testutil.MockResetRepo{}, &testutil.MockEmailSender{}).ForgotPassword(context.Background(), "handle")
	if !errors.Is(err, failure) {
		t.Fatalf("repository failure lost: %v", err)
	}
}
