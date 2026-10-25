package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"golang.org/x/crypto/bcrypt"
)

func WithServerOwnership(repo repository.ServerOwnershipRepository) AuthOption {
	return func(s *authService) { s.serverOwnership = repo }
}

func (s *authService) SetOwnershipInvalidator(inv PermissionInvalidator) {
	s.ownershipInvalidator = inv
}

// TransferServerOwnership requires fresh credential proof. HTTP callers must
// also bind account/server identity and require explicit irreversible consent.
func (s *authService) TransferServerOwnership(ctx context.Context, actor, sid, serverID, target, password, code string) (*models.Server, error) {
	if s.serverOwnership == nil || s.authSessions == nil || s.mfa == nil || s.ownershipInvalidator == nil || s.hub == nil {
		return nil, fmt.Errorf("server ownership security is unavailable")
	}
	security, err := s.mfa.repo.Get(ctx, actor)
	if err != nil {
		return nil, err
	}
	if err := s.verifySessionAction(ctx, actor, sid, password, code); err != nil {
		return nil, err
	}
	user, err := s.userRepo.GetByID(ctx, actor)
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return nil, pkg.ErrUnauthorized
	}
	server, err := s.serverOwnership.Transfer(ctx, actor, sid, user.PasswordHash, security.Secret, serverID, target, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	// The transaction removes all owner-role grants, including inconsistent
	// historical grants. Invalidate every local permission cache after commit.
	s.ownershipInvalidator.InvalidateAll()
	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerUpdate, Data: server})
	return server, nil
}
