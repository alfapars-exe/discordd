package services

import (
	"context"
	"fmt"
	"log"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// MaxPinsPerChannel is the max number of pins per channel (same as Discord: 50).
const MaxPinsPerChannel = 50

type PinService interface {
	Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error)
	Unpin(ctx context.Context, messageID string, channelID string) error
	GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
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
		log.Printf("[pin] bulk permission resolve failed channel=%s: %v", channelID, err)
		return nil
	}

	allowed := make([]string, 0, len(onlineUsers))
	for _, uid := range onlineUsers {
		if perms[uid].Has(models.PermViewChannel) && perms[uid].Has(models.PermReadMessages) {
			allowed = append(allowed, uid)
		}
	}
	return allowed
}

func (s *pinService) Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error) {
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
	log.Printf("[pin] message %s pinned in channel %s by user %s", messageID, channelID, pinnedBy)

	return result, nil
}

func (s *pinService) Unpin(ctx context.Context, messageID string, channelID string) error {
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
	log.Printf("[pin] message %s unpinned in channel %s", messageID, channelID)

	return nil
}

func (s *pinService) GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	return s.pinRepo.GetByChannelID(ctx, channelID)
}
