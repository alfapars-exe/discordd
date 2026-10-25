package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func TestAuthAccountConstraintHasNoCrossAccountSideEffects(t *testing.T) {
	for _, expired := range []bool{false, true} {
		for _, operation := range []string{"refresh", "logout"} {
			t.Run(operation+map[bool]string{false: "/live", true: "/expired"}[expired], func(t *testing.T) {
				writes := 0
				expires := time.Now().Add(time.Hour)
				if expired {
					expires = time.Now().Add(-time.Hour)
				}
				sessions := &testutil.MockSessionRepo{
					GetByRefreshTokenFn: func(context.Context, string) (*models.Session, error) {
						return &models.Session{ID: "session-b", UserID: "b", ExpiresAt: expires}, nil
					},
					DeleteByIDFn:     func(context.Context, string) error { writes++; return nil },
					DeleteByUserIDFn: func(context.Context, string) error { writes++; return nil },
					CreateFn:         func(context.Context, *models.Session) error { writes++; return nil },
				}
				users := &testutil.MockUserRepo{
					GetByIDFn: func(context.Context, string) (*models.User, error) {
						t.Fatal("must not read another account's profile")
						return nil, nil
					},
					UpdateStatusFn: func(context.Context, string, models.UserStatus) error { writes++; return nil },
				}
				svc := newTestAuthService(users, sessions)
				ctx := WithExpectedAuthAccount(context.Background(), "a")
				var err error
				if operation == "refresh" {
					_, err = svc.RefreshToken(ctx, "shared-b-cookie")
				} else {
					err = svc.Logout(ctx, "shared-b-cookie")
				}
				if !errors.Is(err, ErrAuthAccountMismatch) || writes != 0 {
					t.Fatalf("err=%v, writes=%d", err, writes)
				}
			})
		}
	}
}

func TestAuthAccountConstraintDoesNotRevokeAnotherAccountsReusedToken(t *testing.T) {
	writes := 0
	svc := newTestAuthService(&testutil.MockUserRepo{
		IncrementTokenVersionFn: func(context.Context, string) error { writes++; return nil },
	}, &testutil.MockSessionRepo{
		GetByRefreshTokenFn: func(context.Context, string) (*models.Session, error) { return nil, pkg.ErrNotFound },
		DeleteByUserIDFn:    func(context.Context, string) error { writes++; return nil },
	}).(*authService)
	svc.usedRefresh[hashRefreshToken("used-b-cookie")] = usedRefreshEntry{userID: "b", expiresAt: time.Now().Add(time.Hour)}
	_, err := svc.RefreshToken(WithExpectedAuthAccount(context.Background(), "a"), "used-b-cookie")
	if !errors.Is(err, ErrAuthAccountMismatch) || writes != 0 {
		t.Fatalf("err=%v, writes=%d", err, writes)
	}
}
