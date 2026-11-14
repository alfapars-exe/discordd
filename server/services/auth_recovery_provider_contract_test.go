package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"testing"
	"time"
)

func TestRecoveryProviderFailureAndCancellationContracts(t *testing.T) {
	for _, mode := range []string{"provider failure", "request canceled during send", "request deadline during send"} {
		t.Run(mode, func(t *testing.T) {
			canceled := mode == "request canceled during send"
			deadline := mode == "request deadline during send"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if deadline {
				var deadlineCancel context.CancelFunc
				ctx, deadlineCancel = context.WithTimeout(ctx, 100*time.Millisecond)
				defer deadlineCancel()
			}
			failure := errors.New("controlled provider failure")
			if canceled {
				failure = context.Canceled
			}
			if deadline {
				failure = context.DeadlineExceeded
			}
			var storedHash string
			sent := 0
			users := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) {
				return &models.User{ID: "recovery-user", Email: strptr(" user@example.test ")}, nil
			}}
			reset := &testutil.MockResetRepo{
				GetLatestByUserIDFn: func(context.Context, string) (*models.PasswordResetToken, error) { return nil, pkg.ErrNotFound },
				CreateFn: func(_ context.Context, token *models.PasswordResetToken) error {
					storedHash = token.TokenHash
					return nil
				},
			}
			provider := &testutil.MockEmailSender{SendPasswordResetFn: func(sendCtx context.Context, to, token string) error {
				sent++
				digest := sha256.Sum256([]byte(token))
				if to != "user@example.test" || storedHash != hex.EncodeToString(digest[:]) {
					t.Error("provider must receive stored proof and normalized address")
				}
				if deadline {
					<-sendCtx.Done()
					return sendCtx.Err()
				}
				if canceled {
					cancel()
					<-sendCtx.Done()
					return sendCtx.Err()
				}
				return failure
			}}
			cooldown, err := newAuthServiceForReset(users, reset, provider).ForgotPassword(ctx, "user@example.test")
			if !errors.Is(err, failure) || cooldown != 0 || sent != 1 {
				t.Fatalf("provider outcome: cooldown=%d sends=%d cause preserved=%t", cooldown, sent, errors.Is(err, failure))
			}
		})
	}
}

func TestRecoveryStorageFailurePreventsProviderSend(t *testing.T) {
	failure := errors.New("controlled proof persistence failure")
	sent := 0
	users := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) {
		return &models.User{ID: "recovery-user", Email: strptr("user@example.test")}, nil
	}}
	reset := &testutil.MockResetRepo{
		GetLatestByUserIDFn: func(context.Context, string) (*models.PasswordResetToken, error) { return nil, pkg.ErrNotFound },
		CreateFn:            func(context.Context, *models.PasswordResetToken) error { return failure },
	}
	provider := &testutil.MockEmailSender{SendPasswordResetFn: func(context.Context, string, string) error { sent++; return nil }}
	_, err := newAuthServiceForReset(users, reset, provider).ForgotPassword(context.Background(), "user@example.test")
	if !errors.Is(err, failure) || sent != 0 {
		t.Fatalf("storage failure: cause preserved=%t sends=%d", errors.Is(err, failure), sent)
	}
}

func TestRecoveryDisabledConfigurationIsRejectedBeforeLookup(t *testing.T) {
	for _, missingSender := range []bool{true, false} {
		lookedUp := false
		users := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) { lookedUp = true; return nil, pkg.ErrNotFound }}
		var svc AuthService
		if missingSender {
			svc = NewAuthService(users, &testutil.MockSessionRepo{}, &testutil.MockResetRepo{}, &testutil.MockEventPublisher{}, nil, nil, testJWTSecret, 15, 7)
		} else {
			svc = NewAuthService(users, &testutil.MockSessionRepo{}, nil, &testutil.MockEventPublisher{}, &testutil.MockEmailSender{}, nil, testJWTSecret, 15, 7)
		}
		_, err := svc.ForgotPassword(context.Background(), "unknown-handle")
		if !errors.Is(err, ErrPasswordRecoveryUnavailable) || !errors.Is(err, pkg.ErrBadRequest) || lookedUp {
			t.Fatal("disabled recovery must reject uniformly before lookup")
		}
	}
}
