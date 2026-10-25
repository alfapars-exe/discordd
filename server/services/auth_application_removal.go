package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"golang.org/x/crypto/bcrypt"
)

// WithApplicationRemoval installs the transactional application-retirement
// boundary. The service still fails closed unless every runtime invalidator is
// wired before the server starts accepting requests.
func WithApplicationRemoval(repo repository.ApplicationRemovalRepository) AuthOption {
	return func(s *authService) { s.applicationRemoval = repo }
}

func (s *authService) RemoveApplication(ctx context.Context, actor, sid, botID, password, code string) error {
	if s.applicationRemoval == nil || s.authSessions == nil || s.mfa == nil || s.hub == nil || s.ownershipInvalidator == nil || s.userInvalidator == nil || s.voiceKit == nil {
		return fmt.Errorf("application removal security is unavailable")
	}
	security, err := s.mfa.repo.Get(ctx, actor)
	if err != nil {
		return err
	}
	if err := s.verifySessionAction(ctx, actor, sid, password, code); err != nil {
		return err
	}
	user, err := s.userRepo.GetByID(ctx, actor)
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return pkg.ErrUnauthorized
	}
	if err := s.applicationRemoval.Remove(ctx, actor, sid, user.PasswordHash, security.Secret, botID, time.Now().Unix()); err != nil {
		return err
	}
	// Commit precedes runtime effects. Revoke only the retired application's
	// connections/caches; the owner's sign-in and other applications survive.
	s.ownershipInvalidator.InvalidateUser(botID)
	s.afterBoundSessionRevocation(botID)
	return nil
}
