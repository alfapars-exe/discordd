package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/repository"
)

var ErrVerificationUnavailable = errors.New("verification delivery unavailable")
var ErrVerificationCooldown = errors.New("verification request cooldown")
var ErrVerificationChanged = errors.New("email state changed")
var ErrVerificationDelivery = errors.New("verification delivery not confirmed")
var ErrVerificationInvalid = errors.New("invalid or expired verification link")

type EmailVerificationService struct {
	repo   repository.EmailVerificationRepository
	sender email.VerificationSender
	now    func() time.Time
}

func NewEmailVerificationService(repo repository.EmailVerificationRepository, sender email.VerificationSender) *EmailVerificationService {
	return &EmailVerificationService{repo: repo, sender: sender, now: time.Now}
}
func (s *EmailVerificationService) Status(ctx context.Context, owner string) (*models.EmailVerificationStatus, error) {
	status, err := s.repo.Status(ctx, owner, s.now().Unix())
	if err == nil {
		status.DeliveryAvailable = s.sender != nil
	}
	return status, err
}
func (s *EmailVerificationService) Request(ctx context.Context, owner string, generation int64) error {
	if s.sender == nil {
		return ErrVerificationUnavailable
	}
	status, err := s.Status(ctx, owner)
	if err != nil {
		return err
	}
	if status.Generation != generation {
		return ErrVerificationChanged
	}
	if status.Email == nil || status.Verified {
		return pkg.ErrBadRequest
	}
	if status.RetryAfter > 0 {
		return ErrVerificationCooldown
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	now := s.now().Unix()
	ok, err := s.repo.Reserve(ctx, owner, generation, hex.EncodeToString(sum[:]), now, now+1200)
	if err != nil {
		return err
	}
	if !ok {
		return ErrVerificationChanged
	}
	// A provider timeout may occur after acceptance. Keep the hashed proof valid
	// until expiry, but never report successful sending when acceptance is unknown.
	if err := s.sender.SendEmailVerification(ctx, *status.Email, token); err != nil {
		return ErrVerificationDelivery
	}
	return nil
}
func (s *EmailVerificationService) Verify(ctx context.Context, token string) error {
	if len(token) != 64 {
		return ErrVerificationInvalid
	}
	raw, err := hex.DecodeString(token)
	if err != nil || len(raw) != 32 {
		return ErrVerificationInvalid
	}
	sum := sha256.Sum256([]byte(token))
	ok, err := s.repo.Consume(ctx, hex.EncodeToString(sum[:]), s.now().Unix())
	if err != nil {
		return err
	}
	if !ok {
		return ErrVerificationInvalid
	}
	return nil
}
