package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"golang.org/x/crypto/bcrypt"
)

func WithAccountAnonymization(repo repository.AccountAnonymizationRepository) AuthOption {
	return func(s *authService) { s.accountAnonymization = repo }
}

// DeleteAccount is only the credential/runtime part of deletion. The handler
// must additionally require owner affinity and irreversible typed consent.
// Never use administrative HardDeleteUser: shared history must survive.
func (s *authService) DeleteAccount(ctx context.Context, userID, current, password, code string) error {
	if s.accountAnonymization == nil || s.authSessions == nil || s.mfa == nil {
		return fmt.Errorf("account deletion security is unavailable")
	}
	security, err := s.mfa.repo.Get(ctx, userID)
	if err != nil {
		return err
	}
	if err := s.verifySessionAction(ctx, userID, current, password, code); err != nil {
		return err
	}
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return pkg.ErrUnauthorized
	}
	if err := s.accountAnonymization.Anonymize(ctx, userID, current, user.PasswordHash, security.Secret, time.Now().Unix()); err != nil {
		return err
	}
	s.hub.BroadcastToAll(ws.Event{Op: ws.OpGroupDMRefresh, Data: map[string]string{"reason": "membership_changed"}})
	// Durable revocation commits first. This existing path invalidates the
	// HTTP user cache, closes all same-process sockets and disconnects voice.
	s.afterBoundSessionRevocation(userID)
	return nil
}
