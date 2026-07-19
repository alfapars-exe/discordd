package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// ErrBotTokenInvalid is returned when a presented bot bearer token does not map
// to a live (existing, non-revoked) token.
var ErrBotTokenInvalid = errors.New("invalid or revoked bot token")

// BotService creates bot accounts and issues/validates/revokes their tokens.
type BotService struct{ repo *repository.BotRepository }

func NewBotService(repo *repository.BotRepository) *BotService { return &BotService{repo: repo} }

// CreateBot registers a new bot owned by ownerID and returns the bot user plus
// the plaintext token (shown to the owner exactly once — only its hash is
// stored). The username is validated against the same rule as human accounts.
func (s *BotService) CreateBot(ctx context.Context, ownerID string, req models.CreateBotRequest) (*models.User, string, error) {
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)

	// Reuse the human username/display-name rules (3-32, [A-Za-z0-9_]). The
	// placeholder password only satisfies the length check; bots never log in.
	cu := models.CreateUserRequest{Username: req.Username, Password: "placeholder8", DisplayName: req.DisplayName}
	if err := cu.Validate(); err != nil {
		return nil, "", err
	}

	botID, err := s.repo.InsertBotUser(ctx, req.Username, req.DisplayName, ownerID)
	if err != nil {
		return nil, "", fmt.Errorf("create bot user: %w", err)
	}

	token, hash, err := models.GenerateBotToken()
	if err != nil {
		return nil, "", err
	}
	if _, err := s.repo.InsertToken(ctx, botID, hash, nil); err != nil {
		return nil, "", fmt.Errorf("insert token: %w", err)
	}

	dn := req.DisplayName
	return &models.User{ID: botID, Username: req.Username, DisplayName: &dn, IsBot: true, OwnerUserID: &ownerID}, token, nil
}

// ValidateBotToken resolves a bot bearer token to its bot user id. The prefix is
// checked first to avoid a DB lookup for tokens that are obviously not ours.
func (s *BotService) ValidateBotToken(ctx context.Context, token string) (string, error) {
	if !strings.HasPrefix(token, models.BotTokenPrefix) {
		return "", ErrBotTokenInvalid
	}
	botUserID, err := s.repo.BotUserIDByTokenHash(ctx, models.HashBotToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrBotTokenInvalid
	}
	if err != nil {
		return "", err
	}
	return botUserID, nil
}

// ListBots returns every bot owned by the given human.
func (s *BotService) ListBots(ctx context.Context, ownerID string) ([]models.User, error) {
	return s.repo.ListByOwner(ctx, ownerID)
}

// RevokeAllTokens revokes every token of one owned bot (used to disable a bot).
func (s *BotService) RevokeAllTokens(ctx context.Context, ownerID, botID string) error {
	return s.repo.RevokeAllForBot(ctx, ownerID, botID)
}
