package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

func (s *BotService) RegisterGameIdentity(ctx context.Context, ownerID, botID string) (*models.ApplicationGameIdentity, error) {
	if err := s.repo.RegisterGameIdentity(ctx, ownerID, botID); err != nil {
		return nil, err
	}
	return &models.ApplicationGameIdentity{ApplicationID: botID, IsGameApplication: true}, nil
}
func (s *BotService) ListGameGrants(ctx context.Context, userID string) ([]models.ApplicationGameGrant, error) {
	return s.repo.ListGameGrants(ctx, userID)
}
func (s *BotService) ChangeGameGrant(ctx context.Context, userID, botID string, expected int64, enabled, revoke bool) (*models.ApplicationGameGrant, error) {
	return s.repo.ChangeGameGrant(ctx, userID, botID, expected, enabled, revoke)
}
