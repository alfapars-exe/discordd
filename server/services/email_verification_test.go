package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/argeinfina/hichat/repository"
	"testing"
	"time"
)

type verificationSenderFunc func(context.Context, string, string) error

func (f verificationSenderFunc) SendEmailVerification(ctx context.Context, address, token string) error {
	return f(ctx, address, token)
}
func TestEmailVerificationDeliveryAndProof(t *testing.T) {
	h := newMFAHarness(t)
	ctx := context.Background()
	address := "verification@example.invalid"
	users := repository.NewSQLiteUserRepo(h.db.Conn)
	if err := users.UpdateEmail(ctx, h.user.ID, &address); err != nil {
		t.Fatal(err)
	}
	var proof string
	var sends int
	sender := verificationSenderFunc(func(_ context.Context, to, token string) error {
		if to != address {
			t.Fatal("wrong recipient")
		}
		proof = token
		sends++
		return nil
	})
	service := NewEmailVerificationService(repository.NewSQLiteEmailVerificationRepo(h.db.Conn), sender)
	service.now = func() time.Time { return time.Unix(1800000000, 0) }
	status, err := service.Status(ctx, h.user.ID)
	if err != nil || !status.DeliveryAvailable {
		t.Fatal(err)
	}
	if err := service.Request(ctx, h.user.ID, status.Generation); err != nil {
		t.Fatal(err)
	}
	if len(proof) != 64 || sends != 1 {
		t.Fatal("missing independent verification proof")
	}
	var stored string
	if err := h.db.Conn.QueryRow(`SELECT token_hash FROM account_email_tokens WHERE user_id=?`, h.user.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(proof))
	if stored != hex.EncodeToString(sum[:]) || stored == proof {
		t.Fatal("raw token persisted")
	}
	if err := service.Request(ctx, h.user.ID, status.Generation); !errors.Is(err, ErrVerificationCooldown) {
		t.Fatal("cooldown not durable", err)
	}
	if err := service.Verify(ctx, proof); err != nil {
		t.Fatal(err)
	}
	if err := service.Verify(ctx, proof); !errors.Is(err, ErrVerificationInvalid) {
		t.Fatal("proof replay accepted", err)
	}
	status, err = service.Status(ctx, h.user.ID)
	if err != nil || !status.Verified {
		t.Fatal("actual email not verified", err)
	}
}
func TestEmailVerificationUnavailableAndUncertainDelivery(t *testing.T) {
	h := newMFAHarness(t)
	ctx := context.Background()
	address := "verification@example.invalid"
	users := repository.NewSQLiteUserRepo(h.db.Conn)
	if err := users.UpdateEmail(ctx, h.user.ID, &address); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteEmailVerificationRepo(h.db.Conn)
	service := NewEmailVerificationService(repo, nil)
	status, _ := service.Status(ctx, h.user.ID)
	if status.DeliveryAvailable {
		t.Fatal("missing delivery advertised as available")
	}
	if err := service.Request(ctx, h.user.ID, status.Generation); !errors.Is(err, ErrVerificationUnavailable) {
		t.Fatal(err)
	}
	var count int
	_ = h.db.Conn.QueryRow(`SELECT count(*) FROM account_email_tokens`).Scan(&count)
	if count != 0 {
		t.Fatal("unavailable sender created a fake delivery")
	}
	var proof string
	service.sender = verificationSenderFunc(func(_ context.Context, _, token string) error {
		proof = token
		return errors.New("provider timeout, not safe to log")
	})
	if err := service.Request(ctx, h.user.ID, status.Generation); !errors.Is(err, ErrVerificationDelivery) {
		t.Fatal("uncertain send reported acceptance", err)
	}
	// A message can have been accepted before the transport timed out. Its
	// proof remains usable without ever reporting delivery as confirmed.
	if err := service.Verify(ctx, proof); err != nil {
		t.Fatal("uncertain accepted mail lost its proof", err)
	}
	if err := users.UpdateEmail(ctx, h.user.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := users.UpdateEmail(ctx, h.user.ID, &address); err != nil {
		t.Fatal(err)
	}
	if err := service.Request(ctx, h.user.ID, status.Generation); !errors.Is(err, ErrVerificationChanged) {
		t.Fatal("stale email action accepted", err)
	}
}
