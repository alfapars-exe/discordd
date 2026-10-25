package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"golang.org/x/crypto/bcrypt"
)

type AuthOption func(*authService)

var ErrRefreshSuperseded = errors.New("refresh token was already rotated")
var ErrAccountDisabled = errors.New("account is disabled; explicit restoration required")

func WithAccountLifecycle(repo repository.AccountLifecycleRepository) AuthOption {
	return func(s *authService) { s.accountLifecycle = repo }
}

func WithMFA(mfa *MFAService) AuthOption { return func(s *authService) { s.mfa = mfa } }
func WithAuthSessions(repo repository.AuthSessionRepository) AuthOption {
	return func(s *authService) { s.authSessions = repo }
}

type sessionMetadataKey struct{}
type SessionMetadata struct{ ClientType, UserAgent string }

func WithSessionMetadata(ctx context.Context, clientType, userAgent string) context.Context {
	switch clientType {
	case "web", "electron":
	default:
		clientType = "unknown"
	}
	userAgent = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, userAgent)
	if len(userAgent) > 256 {
		userAgent = userAgent[:256]
		for !utf8.ValidString(userAgent) {
			userAgent = userAgent[:len(userAgent)-1]
		}
	}
	return context.WithValue(ctx, sessionMetadataKey{}, SessionMetadata{clientType, userAgent})
}

func newAuthSession(ctx context.Context, userID string, tv int, expiry time.Time) (*models.AuthSession, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	metadata, _ := ctx.Value(sessionMetadataKey{}).(SessionMetadata)
	if metadata.ClientType == "" {
		metadata.ClientType = "unknown"
	}
	now := time.Now().Unix()
	return &models.AuthSession{ID: hex.EncodeToString(raw), UserID: userID, TokenVersion: tv, ClientType: metadata.ClientType, UserAgent: metadata.UserAgent, CreatedAt: now, LastActiveAt: now, ExpiresAt: expiry.Unix()}, nil
}

// The session boundary is checked without a positive-result cache.
func (s *authService) ValidateSession(ctx context.Context, userID, sessionID string) error {
	if s.authSessions == nil {
		return nil
	} // isolated legacy unit-service construction
	if sessionID == "" {
		return fmt.Errorf("%w: session upgrade required", pkg.ErrUnauthorized)
	}
	_, err := s.authSessions.GetActive(ctx, userID, sessionID, time.Now().Unix())
	if errors.Is(err, pkg.ErrNotFound) {
		return fmt.Errorf("%w: session revoked or expired", pkg.ErrUnauthorized)
	}
	return err
}

func (s *authService) generateBoundTokens(ctx context.Context, user *models.User, restore ...*models.AccountLifecycle) (*AuthTokens, error) {
	expires := time.Now().Add(s.refreshExp)
	logical, err := newAuthSession(ctx, user.ID, user.TokenVersion, expires)
	if err != nil {
		return nil, err
	}
	refresh, err := newRefreshSession(user.ID, expires)
	if err != nil {
		return nil, err
	}
	access, err := s.signAccessToken(user, logical.ID)
	if err != nil {
		return nil, err
	}
	var persistErr error
	if len(restore) > 0 {
		persistErr = s.accountLifecycle.RestoreWithSession(ctx, user.ID, restore[0].Version, user.PasswordHash, logical, refresh)
	} else {
		persistErr = s.authSessions.CreateWithRefresh(ctx, logical, refresh)
	}
	if persistErr != nil {
		return nil, persistErr
	}
	public := *user
	public.PasswordHash = ""
	return &AuthTokens{AccessToken: access, RefreshToken: refresh.RefreshToken, User: public, SessionID: logical.ID}, nil
}

func (s *authService) DisableAccount(ctx context.Context, userID, current, password, code string) error {
	if s.accountLifecycle == nil || s.authSessions == nil {
		return fmt.Errorf("account lifecycle unavailable")
	}
	if err := s.verifySessionAction(ctx, userID, current, password, code); err != nil {
		return err
	}
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	// Recheck the same password proof inside the durable transition. A password
	// change between the verification and this read must not authorize disable.
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return pkg.ErrUnauthorized
	}
	if err := s.accountLifecycle.Disable(ctx, userID, current, user.PasswordHash, time.Now().Unix()); err != nil {
		return err
	}
	s.afterBoundSessionRevocation(userID)
	return nil
}

func newRefreshSession(userID string, expires time.Time) (*models.Session, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	return &models.Session{UserID: userID, RefreshToken: hex.EncodeToString(raw), ExpiresAt: expires}, nil
}

func (s *authService) refreshBoundTokens(ctx context.Context, old *models.Session) (*AuthTokens, error) {
	user, err := s.userRepo.GetByID(ctx, old.UserID)
	if err != nil {
		return nil, err
	}
	if user.IsPlatformBanned {
		return nil, pkg.ErrForbidden
	}
	if old.TokenVersion != user.TokenVersion {
		return nil, fmt.Errorf("%w: session revoked", pkg.ErrUnauthorized)
	}
	expires := time.Now().Add(s.refreshExp)
	var logical *models.AuthSession
	if old.AuthSessionID == "" {
		logical, err = newAuthSession(ctx, user.ID, user.TokenVersion, expires)
	} else {
		logical, err = s.authSessions.GetActive(ctx, user.ID, old.AuthSessionID, time.Now().Unix())
	}
	if errors.Is(err, pkg.ErrNotFound) {
		return nil, pkg.ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	logical.ExpiresAt = expires.Unix()
	if logical.ClientType == "unknown" {
		metadata, _ := ctx.Value(sessionMetadataKey{}).(SessionMetadata)
		if metadata.ClientType != "" {
			logical.ClientType = metadata.ClientType
			logical.UserAgent = metadata.UserAgent
		}
	}
	next, err := newRefreshSession(user.ID, expires)
	if err != nil {
		return nil, err
	}
	access, err := s.signAccessToken(user, logical.ID)
	if err != nil {
		return nil, err
	}
	ok, err := s.authSessions.RotateRefresh(ctx, old, next, logical, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	if !ok {
		if old.AuthSessionID != "" && s.ValidateSession(ctx, user.ID, old.AuthSessionID) == nil {
			return nil, ErrRefreshSuperseded
		}
		return nil, fmt.Errorf("%w: refresh token already consumed or session revoked", pkg.ErrUnauthorized)
	}
	s.usedRefreshMu.Lock()
	s.usedRefresh[hashRefreshToken(old.RefreshToken)] = usedRefreshEntry{userID: user.ID, sessionID: logical.ID, rotatedAt: time.Now(), expiresAt: time.Now().Add(s.refreshExp)}
	if len(s.usedRefresh) > usedRefreshEmergencyThreshold {
		now := time.Now()
		for key, entry := range s.usedRefresh {
			if now.After(entry.expiresAt) {
				delete(s.usedRefresh, key)
			}
		}
	}
	s.usedRefreshMu.Unlock()
	public := *user
	public.PasswordHash = ""
	return &AuthTokens{AccessToken: access, RefreshToken: next.RefreshToken, User: public, SessionID: logical.ID}, nil
}

func (s *authService) ListSessions(ctx context.Context, userID, current string) ([]models.AuthSession, error) {
	if s.authSessions == nil {
		return nil, fmt.Errorf("session management unavailable")
	}
	if err := s.ValidateSession(ctx, userID, current); err != nil {
		return nil, err
	}
	list, err := s.authSessions.ListActive(ctx, userID, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	for i := range list {
		list[i].Current = list[i].ID == current
	}
	return list, nil
}

func (s *authService) verifySessionAction(ctx context.Context, userID, current, password, code string) error {
	if err := s.ValidateSession(ctx, userID, current); err != nil {
		return err
	}
	if s.mfa != nil {
		if err := s.mfa.attempt(ctx, userID); err != nil {
			return err
		}
	}
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}
	if s.mfa != nil {
		record, err := s.mfa.repo.Get(ctx, userID)
		if err != nil {
			return err
		}
		if record.Secret != "" {
			if strings.TrimSpace(code) == "" {
				return ErrMFARequired
			}
			_, err = s.mfa.verify(ctx, userID, code)
			return err
		}
	}
	return nil
}

func (s *authService) EndSession(ctx context.Context, userID, id string) error {
	if s.authSessions == nil {
		return fmt.Errorf("session management unavailable")
	}
	if _, err := s.authSessions.Revoke(ctx, userID, id, time.Now().Unix()); err != nil {
		return err
	}
	s.disconnectSession(userID, id)
	return nil
}

func (s *authService) disconnectSession(userID, id string) {
	if hub, ok := s.hub.(interface{ DisconnectSession(string, string) }); ok {
		hub.DisconnectSession(userID, id)
	}
}
func (s *authService) RevokeSession(ctx context.Context, userID, current, target, password, code string) error {
	if s.authSessions == nil {
		return fmt.Errorf("session management unavailable")
	}
	if err := s.verifySessionAction(ctx, userID, current, password, code); err != nil {
		return err
	}
	ok, err := s.authSessions.Revoke(ctx, userID, target, time.Now().Unix(), current)
	if err != nil {
		return err
	}
	if !ok {
		return pkg.ErrNotFound
	}
	s.disconnectSession(userID, target)
	return nil
}
func (s *authService) RevokeOtherSessions(ctx context.Context, userID, current, password, code string) (int, error) {
	if s.authSessions == nil {
		return 0, fmt.Errorf("session management unavailable")
	}
	if err := s.verifySessionAction(ctx, userID, current, password, code); err != nil {
		return 0, err
	}
	ids, err := s.authSessions.RevokeOthers(ctx, userID, current, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		s.disconnectSession(userID, id)
	}
	return len(ids), nil
}

func (s *authService) RevokeAllSessionsVerified(ctx context.Context, userID, current, password, code string) error {
	if s.authSessions == nil {
		return fmt.Errorf("session management unavailable")
	}
	if err := s.verifySessionAction(ctx, userID, current, password, code); err != nil {
		return err
	}
	// Commit the durable boundary before best-effort disconnect/cache work.
	return s.revokeBoundSessions(ctx, userID)
}

func (s *authService) revokeBoundSessions(ctx context.Context, userID string) error {
	if err := s.authSessions.RevokeAll(ctx, userID, time.Now().Unix()); err != nil {
		return err
	}
	s.afterBoundSessionRevocation(userID)
	return nil
}

func (s *authService) afterBoundSessionRevocation(userID string) {
	s.invalidateUserCache(userID)
	if s.hub != nil {
		s.hub.DisconnectUser(userID)
	}
	s.disconnectVoice(userID)
}
