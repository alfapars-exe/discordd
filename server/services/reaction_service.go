package services

import (
	"context"
	"fmt"
	"log"
	"unicode/utf8"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// MaxEmojiLength caps emoji string length. Most emojis are 1-2 codepoints but
// compound emojis (family, flag) can exceed 10. 32 provides a safe margin.
const MaxEmojiLength = 32

type ReactionService interface {
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) error
}

type reactionService struct {
	reactionRepo repository.ReactionRepository
	messageRepo  repository.MessageRepository
	channelRepo  repository.ChannelRepository
	hub          ws.BroadcastAndOnline
	permResolver ChannelPermResolver
}

func NewReactionService(
	reactionRepo repository.ReactionRepository,
	messageRepo repository.MessageRepository,
	channelRepo repository.ChannelRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
) ReactionService {
	return &reactionService{
		reactionRepo: reactionRepo,
		messageRepo:  messageRepo,
		channelRepo:  channelRepo,
		hub:          hub,
		permResolver: permResolver,
	}
}

// ToggleReaction adds or removes an emoji reaction on a message.
// Same endpoint toggles: call again to remove.
func (s *reactionService) ToggleReaction(ctx context.Context, messageID, userID, emoji string) error {
	if emoji == "" {
		return fmt.Errorf("%w: emoji is required", pkg.ErrBadRequest)
	}
	if utf8.RuneCountInString(emoji) > MaxEmojiLength {
		return fmt.Errorf("%w: emoji too long", pkg.ErrBadRequest)
	}

	// Verify message exists (also need channel_id for broadcast)
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}

	added, err := s.reactionRepo.Toggle(ctx, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("failed to toggle reaction: %w", err)
	}

	reactions, err := s.reactionRepo.GetByMessageID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get reactions after toggle: %w", err)
	}

	// Only broadcast to users who can view + read this channel.
	event := ws.Event{
		Op: ws.OpReactionUpdate,
		Data: map[string]any{
			"message_id":        messageID,
			"channel_id":        message.ChannelID,
			"reactions":         reactions,
			"actor_id":          userID,
			"message_author_id": message.UserID,
			"added":             added,
		},
	}

	// Scope permission checks to the channel's server members.
	channel, chErr := s.channelRepo.GetByID(ctx, message.ChannelID)
	if chErr != nil || channel == nil {
		return nil
	}

	// One bulk resolve for the whole recipient list — resolving per online
	// member cost 3 queries each on a cold permission cache.
	onlineUsers := s.hub.GetOnlineUserIDsForServer(channel.ServerID)
	perms, permErr := s.permResolver.ResolveChannelPermissionsBulk(ctx, message.ChannelID, onlineUsers)
	if permErr != nil {
		log.Printf("[reaction] bulk permission resolve failed channel=%s: %v", message.ChannelID, permErr)
		return nil
	}

	allowed := make([]string, 0, len(onlineUsers))
	for _, uid := range onlineUsers {
		if perms[uid].Has(models.PermViewChannel) && perms[uid].Has(models.PermReadMessages) {
			allowed = append(allowed, uid)
		}
	}
	s.hub.BroadcastToUsers(allowed, event)

	return nil
}
