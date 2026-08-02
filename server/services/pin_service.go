package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var pinLogger = logx.Component("service.pin")

// MaxPinsPerChannel is the max number of pins per channel (same as Discord: 50).
const MaxPinsPerChannel = 50

type PinService interface {
	Pin(ctx context.Context, serverID, messageID, channelID, pinnedBy string) (*models.PinnedMessageWithDetails, error)
	Unpin(ctx context.Context, serverID, messageID, channelID, userID string) error
	GetPinnedMessages(ctx context.Context, serverID, channelID, userID string) ([]models.PinnedMessageWithDetails, error)
}

type pinService struct {
	pinRepo      repository.PinRepository
	messageRepo  repository.MessageRepository
	channelRepo  repository.ChannelRepository
	hub          ws.BroadcastAndOnline
	permResolver ChannelPermResolver
}

func NewPinService(
	pinRepo repository.PinRepository,
	messageRepo repository.MessageRepository,
	channelRepo repository.ChannelRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
) PinService {
	return &pinService{
		pinRepo:      pinRepo,
		messageRepo:  messageRepo,
		channelRepo:  channelRepo,
		hub:          hub,
		permResolver: permResolver,
	}
}

// allowedViewers returns online user IDs that have ViewChannel + ReadMessages on the channel.
// Scoped to the channel's server members.
//
// Mirrors messageService.allowedViewers: one bulk resolve instead of one per
// online member, under a bounded background context because this runs after
// the pin write has already committed.
func (s *pinService) allowedViewers(channelID string) []string {
	ctx, cancel := BroadcastContext()
	defer cancel()

	channel, err := s.channelRepo.GetByID(ctx, channelID)
	if err != nil || channel == nil {
		return nil
	}

	onlineUsers := s.hub.GetOnlineUserIDsForServer(channel.ServerID)
	perms, err := s.permResolver.ResolveChannelPermissionsBulk(ctx, channelID, onlineUsers)
	if err != nil {
		pinLogger.Error("bulk permission resolve failed", "channel_id", channelID, "err", pkg.ErrText(err))
		return nil
	}

	allowed := make([]string, 0, len(onlineUsers))
	for _, uid := range onlineUsers {
		if models.PermCanReadChannel(perms[uid]) {
			allowed = append(allowed, uid)
		}
	}
	return allowed
}

// requireManageMessages honours a channel-level ManageMessages override on the
// pin write paths. The route middleware already verified server-wide
// ManageMessages; this additionally resolves the user's EFFECTIVE permission in
// this channel, so a per-channel deny-override is respected — matching how
// GetPinnedMessages already gates reads. Admin bypasses via Permission.Has.
//
// A-29c audit note: Pin/Unpin deliberately do NOT add a member-timeout
// gate (unlike message_service.Create/Update). Both already require
// PermManageMessages here, so the only user who could exploit a missing
// gate is a moderator who is themselves timed out — a self-contradictory,
// low-probability edge case, and Pin/Unpin don't post attacker-controlled
// content (they only reference an existing message id). Not worth the
// extra IsActive round trip on every pin/unpin; revisit if timeout ever
// starts stripping permissions instead of being an independent gate.
func (s *pinService) requireManageMessages(ctx context.Context, userID, channelID string) error {
	perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !perms.Has(models.PermManageMessages) {
		return fmt.Errorf("%w: manage messages permission required for this channel", pkg.ErrForbidden)
	}
	return nil
}

func (s *pinService) Pin(ctx context.Context, serverID, messageID, channelID, pinnedBy string) (*models.PinnedMessageWithDetails, error) {
	if _, err := s.validateChannelScope(ctx, serverID, channelID); err != nil {
		return nil, err
	}
	if err := s.requireManageMessages(ctx, pinnedBy, channelID); err != nil {
		return nil, err
	}

	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return nil, err
	}
	if message.ChannelID != channelID {
		return nil, fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	count, err := s.pinRepo.CountByChannelID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pin count: %w", err)
	}
	if count >= MaxPinsPerChannel {
		return nil, fmt.Errorf("%w: channel has reached the maximum number of pins (%d)", pkg.ErrBadRequest, MaxPinsPerChannel)
	}

	pin := &models.PinnedMessage{
		MessageID: messageID,
		ChannelID: channelID,
		PinnedBy:  pinnedBy,
	}
	if err := s.pinRepo.Pin(ctx, pin); err != nil {
		return nil, err
	}

	result := &models.PinnedMessageWithDetails{
		PinnedMessage: *pin,
		Message:       message,
	}

	s.hub.BroadcastToUsers(s.allowedViewers(channelID), ws.Event{
		Op:   ws.OpMessagePin,
		Data: result,
	})
	pinLogger.Info("message pinned", "message_id", messageID, "channel_id", channelID, "pinned_by", pinnedBy)

	return result, nil
}

func (s *pinService) Unpin(ctx context.Context, serverID, messageID, channelID, userID string) error {
	if _, err := s.validateChannelScope(ctx, serverID, channelID); err != nil {
		return err
	}
	if err := s.requireManageMessages(ctx, userID, channelID); err != nil {
		return err
	}

	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}
	if message.ChannelID != channelID {
		return fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	if err := s.pinRepo.Unpin(ctx, messageID); err != nil {
		return err
	}

	s.hub.BroadcastToUsers(s.allowedViewers(channelID), ws.Event{
		Op: ws.OpMessageUnpin,
		Data: map[string]string{
			"message_id": messageID,
			"channel_id": channelID,
		},
	})
	pinLogger.Info("message unpinned", "message_id", messageID, "channel_id", channelID)

	return nil
}

func (s *pinService) GetPinnedMessages(ctx context.Context, serverID, channelID, userID string) ([]models.PinnedMessageWithDetails, error) {
	if _, err := s.validateChannelScope(ctx, serverID, channelID); err != nil {
		return nil, err
	}

	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(channelPerms) {
		return nil, fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

	return s.pinRepo.GetByChannelID(ctx, channelID)
}

func (s *pinService) validateChannelScope(ctx context.Context, serverID, channelID string) (*models.Channel, error) {
	return resolveChannelInServer(ctx, s.channelRepo, serverID, channelID)
}
