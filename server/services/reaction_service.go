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

var reactionLogger = logx.Component("service.reaction")

type ReactionService interface {
	ToggleReaction(ctx context.Context, serverID, messageID, userID, emoji string) error
	SetEmojiResolver(r EmojiResolver)
}

type reactionService struct {
	reactionRepo   repository.ReactionRepository
	messageRepo    repository.MessageRepository
	channelRepo    repository.ChannelRepository
	hub            ws.BroadcastAndOnline
	permResolver   ChannelPermResolver
	timeoutChecker MemberTimeoutChecker
	// emojiResolver validates custom-emoji reactions (reaction_emoji.go);
	// nil rejects every custom emoji. Set via SetEmojiResolver.
	emojiResolver EmojiResolver
}

func NewReactionService(
	reactionRepo repository.ReactionRepository,
	messageRepo repository.MessageRepository,
	channelRepo repository.ChannelRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
	timeoutChecker MemberTimeoutChecker,
) ReactionService {
	return &reactionService{
		reactionRepo:   reactionRepo,
		messageRepo:    messageRepo,
		channelRepo:    channelRepo,
		hub:            hub,
		permResolver:   permResolver,
		timeoutChecker: timeoutChecker,
	}
}

// ToggleReaction adds or removes an emoji reaction on a message.
// Same endpoint toggles: call again to remove.
func (s *reactionService) ToggleReaction(ctx context.Context, serverID, messageID, userID, emoji string) error {
	emoji, removeOnly, err := validateReactionEmoji(ctx, s.emojiResolver, userID, emoji)
	if err != nil {
		return err
	}

	// Verify message exists (also need channel_id for broadcast)
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}

	// Scope: the message's channel must belong to serverID before we touch
	// the reaction store — otherwise a member of server A could react to a
	// message living in server B by guessing/observing its messageID.
	channel, err := resolveChannelInServer(ctx, s.channelRepo, serverID, message.ChannelID)
	if err != nil {
		return err
	}

	// Timeout gate — same rationale as messageService.Create and the voice
	// join/token gates: a timed-out user can't react to messages either.
	// channel.ServerID != "" is structural defense-in-depth — DM channels
	// never reach here because resolveChannelInServer above already scopes
	// message.ChannelID to serverID, but the guard costs nothing.
	if s.timeoutChecker != nil && channel.ServerID != "" {
		active, err := s.timeoutChecker.IsActive(ctx, channel.ServerID, userID)
		if err != nil {
			return fmt.Errorf("check timeout: %w", err)
		}
		if active {
			return fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	// Actor must be able to view + read this channel (mirrors the
	// pinService.GetPinnedMessages gate).
	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, message.ChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(channelPerms) {
		return fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

	// A custom emoji that no longer validates can only be taken back:
	// delete-only, and the same unknown-emoji error when nothing matched.
	var added bool
	if removeOnly {
		removed, err := s.reactionRepo.RemoveReaction(ctx, messageID, userID, emoji)
		if err != nil {
			return fmt.Errorf("failed to remove reaction: %w", err)
		}
		if !removed {
			return models.ErrUnknownEmoji
		}
	} else {
		added, err = s.reactionRepo.Toggle(ctx, messageID, userID, emoji)
		if err != nil {
			return fmt.Errorf("failed to toggle reaction: %w", err)
		}
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

	// One bulk resolve for the whole recipient list — resolving per online
	// member cost 3 queries each on a cold permission cache.
	onlineUsers := s.hub.GetOnlineUserIDsForServer(channel.ServerID)
	perms, permErr := s.permResolver.ResolveChannelPermissionsBulk(ctx, message.ChannelID, onlineUsers)
	if permErr != nil {
		reactionLogger.Error("bulk permission resolve failed", "channel_id", message.ChannelID, "err", pkg.ErrText(permErr))
		return nil
	}

	allowed := make([]string, 0, len(onlineUsers))
	for _, uid := range onlineUsers {
		if models.PermCanReadChannel(perms[uid]) {
			allowed = append(allowed, uid)
		}
	}
	s.hub.BroadcastToUsers(allowed, event)

	return nil
}
