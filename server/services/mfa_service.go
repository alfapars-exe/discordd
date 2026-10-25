package services

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	crypt "github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrMFARequired    = errors.New("MFA verification required")
	ErrMFAInvalid     = errors.New("invalid or already used verification code")
	ErrMFARateLimited = errors.New("too many security attempts; try again later")
)

type MFAService struct {
	repo  repository.MFARepository
	users repository.UserRepository
	key   []byte
	now   func() time.Time
}

func NewMFAService(repo repository.MFARepository, users repository.UserRepository, key []byte) *MFAService {
	return &MFAService{repo: repo, users: users, key: append([]byte(nil), key...), now: time.Now}
}

func (s *MFAService) accountKey(userID string) []byte {
	h := hmac.New(sha256.New, s.key)
	_, _ = h.Write([]byte("hichat-account-mfa-v1:" + userID))
	return h.Sum(nil)
}

func (s *MFAService) attempt(ctx context.Context, userID string) error {
	if len(s.key) != 32 {
		return fmt.Errorf("%w: MFA is not configured", pkg.ErrInternal)
	}
	ok, err := s.repo.ReserveAttempt(ctx, userID, s.now().Unix())
	if err != nil {
		return err
	}
	if !ok {
		return ErrMFARateLimited
	}
	return nil
}

func (s *MFAService) password(ctx context.Context, userID, password string) error {
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if user.IsBot {
		return pkg.ErrForbidden
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}
	return nil
}

func (s *MFAService) Status(ctx context.Context, userID string) (*models.MFAStatus, error) {
	record, err := s.repo.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &models.MFAStatus{Enabled: record.Secret != "", RecoveryRemaining: record.RecoveryRemaining}, nil
}

func (s *MFAService) Cancel(ctx context.Context, userID, setupID string) error {
	if setupID == "" {
		return ErrMFAInvalid
	}
	ok, err := s.repo.CancelSetup(ctx, userID, setupID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMFAInvalid
	}
	return nil
}

func (s *MFAService) Begin(ctx context.Context, userID, password string) (*models.MFASetup, error) {
	if err := s.attempt(ctx, userID); err != nil {
		return nil, err
	}
	if err := s.password(ctx, userID, password); err != nil {
		return nil, err
	}
	secretBytes := make([]byte, 20)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secretBytes)
	encrypted, err := crypt.Encrypt(secret, s.accountKey(userID))
	if err != nil {
		return nil, err
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(idBytes)
	expires := s.now().Add(10 * time.Minute).Unix()
	ok, err := s.repo.Prepare(ctx, userID, encrypted, id, expires)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: MFA is already enabled", pkg.ErrAlreadyExists)
	}
	values := url.Values{"secret": {secret}, "issuer": {"HiChat"}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}
	return &models.MFASetup{SetupID: id, Secret: secret, URI: "otpauth://totp/" + url.PathEscape("HiChat:"+userID) + "?" + values.Encode(), ExpiresAt: expires}, nil
}

func recoveryHash(userID, code string) string {
	// Codes contain 128 random bits; a slow password KDF is unnecessary.
	normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte("hichat-recovery-v1:" + userID + ":" + normalized))
	return hex.EncodeToString(sum[:])
}

func newRecoveryCodes(userID string) ([]string, []string, error) {
	codes := make([]string, 10)
	hashes := make([]string, 10)
	for i := range codes {
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			return nil, nil, err
		}
		encoded := hex.EncodeToString(raw)
		codes[i] = encoded[:8] + "-" + encoded[8:16] + "-" + encoded[16:24] + "-" + encoded[24:]
		hashes[i] = recoveryHash(userID, codes[i])
	}
	return codes, hashes, nil
}

func (s *MFAService) Confirm(ctx context.Context, userID, setupID, code string) ([]string, error) {
	if err := s.attempt(ctx, userID); err != nil {
		return nil, err
	}
	record, err := s.repo.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	if record.Secret != "" || record.PendingID != setupID || setupID == "" || record.PendingExpires <= s.now().Unix() {
		return nil, ErrMFAInvalid
	}
	secret, err := crypt.Decrypt(record.PendingSecret, s.accountKey(userID))
	if err != nil {
		return nil, fmt.Errorf("MFA secret unavailable")
	}
	step, valid := crypt.MatchTOTP(secret, code, s.now().Unix())
	if !valid {
		return nil, ErrMFAInvalid
	}
	codes, hashes, err := newRecoveryCodes(userID)
	if err != nil {
		return nil, err
	}
	ok, err := s.repo.Enable(ctx, userID, setupID, s.now().Unix(), step, hashes)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMFAInvalid
	}
	return codes, nil
}

func (s *MFAService) verify(ctx context.Context, userID, code string) (*models.MFARecord, error) {
	record, err := s.repo.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	if record.Secret == "" {
		return nil, ErrMFAInvalid
	}
	secret, err := crypt.Decrypt(record.Secret, s.accountKey(userID))
	if err != nil {
		return nil, fmt.Errorf("MFA secret unavailable")
	}
	var ok bool
	if step, valid := crypt.MatchTOTP(secret, code, s.now().Unix()); valid {
		ok, err = s.repo.ConsumeTOTP(ctx, userID, record.Secret, step)
	} else {
		ok, err = s.repo.ConsumeRecovery(ctx, userID, record.Secret, recoveryHash(userID, code))
	}
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMFAInvalid
	}
	return record, nil
}

// CheckLogin is called only AFTER the password and account-state checks and
// BEFORE any access token, refresh session, presence update or cookie issuance.
func (s *MFAService) CheckLogin(ctx context.Context, userID, code string) error {
	record, err := s.repo.Get(ctx, userID)
	if err != nil {
		return err
	}
	if record.Secret == "" {
		return nil
	}
	if strings.TrimSpace(code) == "" {
		return ErrMFARequired
	}
	if err := s.attempt(ctx, userID); err != nil {
		return err
	}
	_, err = s.verify(ctx, userID, code)
	return err
}

func (s *MFAService) Regenerate(ctx context.Context, userID, password, code string) ([]string, error) {
	if err := s.attempt(ctx, userID); err != nil {
		return nil, err
	}
	if err := s.password(ctx, userID, password); err != nil {
		return nil, err
	}
	record, err := s.verify(ctx, userID, code)
	if err != nil {
		return nil, err
	}
	codes, hashes, err := newRecoveryCodes(userID)
	if err != nil {
		return nil, err
	}
	ok, err := s.repo.ReplaceRecovery(ctx, userID, record.Secret, record.RecoveryVersion, hashes)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMFAInvalid
	}
	return codes, nil
}

func (s *MFAService) Disable(ctx context.Context, userID, password, code string) error {
	if err := s.attempt(ctx, userID); err != nil {
		return err
	}
	if err := s.password(ctx, userID, password); err != nil {
		return err
	}
	record, err := s.verify(ctx, userID, code)
	if err != nil {
		return err
	}
	ok, err := s.repo.Disable(ctx, userID, record.Secret)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMFAInvalid
	}
	return nil
}
