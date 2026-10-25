package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// ErrBotTokenInvalid is returned when a presented bot bearer token does not map
// to a live (existing, non-revoked) token.
var ErrBotTokenInvalid = errors.New("invalid or revoked bot token")

// BotService creates bot accounts and issues/validates/revokes their tokens.
type BotRuntimeDisconnecter interface{ DisconnectUser(string) }
type ApplicationActionBroadcaster interface{ BroadcastToUser(string, ws.Event) }
type ApplicationPermissionResolver interface {
	ResolveChannelPermissions(context.Context, string, string) (models.Permission, error)
}
type ApplicationMembershipRuntime interface {
	AddClientServerID(string, string)
	RemoveClientServerID(string, string)
}

type BotService struct {
	repo         *repository.BotRepository
	disconnecter BotRuntimeDisconnecter
	broadcaster  ApplicationActionBroadcaster
	permissions  ApplicationPermissionResolver
	memberships  ApplicationMembershipRuntime
}

func NewBotService(repo *repository.BotRepository, disconnecter ...BotRuntimeDisconnecter) *BotService {
	s := &BotService{repo: repo}
	if len(disconnecter) > 0 {
		s.disconnecter = disconnecter[0]
		if broadcaster, ok := disconnecter[0].(ApplicationActionBroadcaster); ok {
			s.broadcaster = broadcaster
		}
		if memberships, ok := disconnecter[0].(ApplicationMembershipRuntime); ok {
			s.memberships = memberships
		}
	}
	return s
}

func (s *BotService) SetApplicationPermissionResolver(resolver ApplicationPermissionResolver) {
	s.permissions = resolver
}

var applicationActionName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

func (s *BotService) PutApplicationManifest(ctx context.Context, ownerID, botID, description string, testMode bool, actions []models.ApplicationAction) (*models.ApplicationManifest, error) {
	description = strings.TrimSpace(description)
	if len(description) > 500 || len(actions) > 10 {
		return nil, pkg.ErrBadRequest
	}
	seen := map[string]bool{}
	for i := range actions {
		actions[i].Name = strings.TrimSpace(actions[i].Name)
		actions[i].Label = strings.TrimSpace(actions[i].Label)
		actions[i].Context = "message"
		if !applicationActionName.MatchString(actions[i].Name) || actions[i].Label == "" || len(actions[i].Label) > 64 || seen[actions[i].Name] {
			return nil, pkg.ErrBadRequest
		}
		seen[actions[i].Name] = true
	}
	return s.repo.PutManifest(ctx, ownerID, botID, description, testMode, actions)
}
func (s *BotService) ListOwnedApplicationManifests(ctx context.Context, ownerID string) ([]models.ApplicationManifest, error) {
	return s.repo.ListOwnedManifests(ctx, ownerID)
}

var allowedApplicationScopes = map[string]bool{models.ApplicationScopeReadMessage: true, models.ApplicationScopeSendResponse: true}

func normalizeApplicationScopes(scopes []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		scope = strings.TrimSpace(scope)
		if !allowedApplicationScopes[scope] || seen[scope] {
			return nil, pkg.ErrBadRequest
		}
		seen[scope] = true
		out = append(out, scope)
	}
	if len(out) == 0 {
		return nil, pkg.ErrBadRequest
	}
	sort.Strings(out)
	return out, nil
}
func (s *BotService) InstallApplication(ctx context.Context, actorID, serverID, botID string, scopes []string) (*models.ApplicationInstallation, error) {
	normalized, err := normalizeApplicationScopes(scopes)
	if err != nil {
		return nil, err
	}
	installation, err := s.repo.InstallApplication(ctx, actorID, serverID, botID, normalized)
	if err == nil && s.memberships != nil {
		s.memberships.AddClientServerID(botID, serverID)
	}
	return installation, err
}
func (s *BotService) ListApplicationInstallations(ctx context.Context, serverID string) ([]models.ApplicationInstallation, error) {
	return s.repo.ListInstallations(ctx, serverID)
}
func (s *BotService) ListAvailableApplicationActions(ctx context.Context, serverID string) ([]models.ApplicationAction, error) {
	return s.repo.ListAvailableApplicationActions(ctx, serverID)
}
func (s *BotService) RevokeApplicationInstallation(ctx context.Context, serverID, botID string) error {
	if err := s.repo.RevokeInstallation(ctx, serverID, botID); err != nil {
		return err
	}
	if s.memberships != nil {
		s.memberships.RemoveClientServerID(botID, serverID)
	}
	return nil
}

func (s *BotService) InvokeApplicationAction(ctx context.Context, actorID, serverID, channelID, messageID, actionID string) (*models.ApplicationInvocation, error) {
	if s.permissions == nil || s.broadcaster == nil {
		return nil, fmt.Errorf("application invocation unavailable")
	}
	perms, err := s.permissions.ResolveChannelPermissions(ctx, actorID, channelID)
	if err != nil {
		return nil, err
	}
	if !models.PermCanReadChannel(perms) {
		return nil, pkg.ErrForbidden
	}
	invocation, err := s.repo.CreateInvocation(ctx, actorID, serverID, channelID, messageID, actionID, time.Now().Add(2*time.Minute))
	if err != nil {
		return nil, err
	}
	s.broadcaster.BroadcastToUser(invocation.Invocation.BotID, ws.Event{Op: ws.OpApplicationInvocation, ServerID: serverID, Data: invocation})
	return &invocation.Invocation, nil
}
func (s *BotService) InvokeApplicationTest(ctx context.Context, ownerID, botID, actionID string) (*models.ApplicationInvocation, error) {
	if s.broadcaster == nil {
		return nil, fmt.Errorf("application invocation unavailable")
	}
	invocation, err := s.repo.CreateTestInvocation(ctx, ownerID, botID, actionID, time.Now().Add(2*time.Minute))
	if err != nil {
		return nil, err
	}
	s.broadcaster.BroadcastToUser(botID, ws.Event{Op: ws.OpApplicationInvocation, Data: invocation})
	return &invocation.Invocation, nil
}
func (s *BotService) CompleteApplicationInvocation(ctx context.Context, botID, id, status string, resultText, errorCode *string) error {
	if status != "succeeded" && status != "failed" {
		return pkg.ErrBadRequest
	}
	if resultText != nil && len(*resultText) > 2000 {
		return pkg.ErrBadRequest
	}
	if errorCode != nil && !applicationActionName.MatchString(*errorCode) {
		return pkg.ErrBadRequest
	}
	return s.repo.CompleteInvocation(ctx, botID, id, status, resultText, errorCode, time.Now())
}
func (s *BotService) GetApplicationInvocation(ctx context.Context, actorID, id string) (*models.ApplicationInvocation, error) {
	inv, err := s.repo.InvocationByID(ctx, actorID, id)
	if err != nil {
		return nil, err
	}
	if inv.Status == "pending" && time.Now().After(inv.ExpiresAt) {
		inv.Status = "expired"
	}
	return inv, nil
}

// CreateBot registers a new bot owned by ownerID and returns the bot user plus
// the plaintext token (shown to the owner exactly once — only its hash is
// stored). The username is validated against the same rule as human accounts.
func (s *BotService) CreateBot(ctx context.Context, ownerID string, req models.CreateBotRequest) (*models.User, string, error) {
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)

	// Reuse the human username/display-name rules (3-32, [A-Za-z0-9_]). The
	// placeholder password only satisfies the length check; bots never log in.
	// Bots do not have human recovery mailboxes; use a validation-only
	// placeholder while keeping mandatory email collection for human signup.
	cu := models.CreateUserRequest{Username: req.Username, Password: "placeholder8", DisplayName: req.DisplayName, Email: "bot@localhost.invalid"}
	if err := cu.Validate(); err != nil {
		return nil, "", err
	}

	token, hash, err := models.GenerateBotToken()
	if err != nil {
		return nil, "", err
	}
	botID, err := s.repo.CreateBotWithToken(ctx, req.Username, req.DisplayName, ownerID, hash)
	if err != nil {
		return nil, "", fmt.Errorf("create bot and initial token: %w", err)
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
	owned, err := s.repo.RevokeAllForBot(ctx, ownerID, botID)
	if err != nil {
		return err
	}
	if !owned {
		return pkg.ErrNotFound
	}
	// The durable credential tombstone commits first. Same-process sockets are
	// then closed immediately; other processes fail their periodic token check.
	if s.disconnecter != nil {
		s.disconnecter.DisconnectUser(botID)
	}
	return nil
}

func (s *BotService) RequestOwnershipTransfer(ctx context.Context, ownerID, botID, recipientUsername string) (*models.ApplicationTransferRequest, error) {
	recipientUsername = strings.TrimSpace(recipientUsername)
	if recipientUsername == "" {
		return nil, pkg.ErrBadRequest
	}
	request, err := s.repo.CreateTransferRequest(ctx, ownerID, botID, recipientUsername, time.Now().Add(7*24*time.Hour))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	return request, err
}

func (s *BotService) ListIncomingOwnershipTransfers(ctx context.Context, recipientID string) ([]models.ApplicationTransferRequest, error) {
	return s.repo.ListIncomingTransfers(ctx, recipientID, time.Now())
}

func (s *BotService) ResolveOwnershipTransfer(ctx context.Context, recipientID, requestID string, accept bool) (string, error) {
	if requestID == "" {
		return "", pkg.ErrBadRequest
	}
	if !accept {
		_, err := s.repo.ResolveTransfer(ctx, recipientID, requestID, "", false, time.Now())
		if errors.Is(err, sql.ErrNoRows) {
			return "", pkg.ErrNotFound
		}
		return "", err
	}
	token, hash, err := models.GenerateBotToken()
	if err != nil {
		return "", err
	}
	botID, err := s.repo.ResolveTransfer(ctx, recipientID, requestID, hash, true, time.Now())
	if errors.Is(err, sql.ErrNoRows) {
		return "", pkg.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if s.disconnecter != nil {
		s.disconnecter.DisconnectUser(botID)
	}
	return token, nil
}
