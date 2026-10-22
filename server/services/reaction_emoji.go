package services

import (
	"context"
	"errors"
	"strings"

	"github.com/argeinfina/hichat/models"
)

// EmojiResolver confirms a custom emoji may be used as a reaction by userID:
// it exists, its animated flag matches, and userID is a member of the
// emoji's server. Every failure is the same models.ErrUnknownEmoji so an
// emoji id cannot be probed. Satisfied by EmojiService.
type EmojiResolver interface {
	ResolveForReaction(ctx context.Context, userID, emojiID string, animated bool) error
}

// validateReactionEmoji checks a channel or DM reaction value and returns
// the key to store: the trimmed Unicode emoji, or "<:ID>" / "<a:ID>" for a
// custom emoji (models.ParseReactionEmoji has the grammar).
//
// removeOnly is true for a well-formed custom key the resolver rejects with
// models.ErrUnknownEmoji (emoji deleted, caller left its server, or a nil
// resolver): such a reaction may still be taken back but never added, so
// the caller must use the delete-only RemoveReaction — never Toggle — and
// answer models.ErrUnknownEmoji when nothing was removed.
func validateReactionEmoji(ctx context.Context, r EmojiResolver, userID, emoji string) (key string, removeOnly bool, err error) {
	custom, id, animated, err := models.ParseReactionEmoji(emoji)
	if err != nil {
		return "", false, err
	}
	if !custom {
		return strings.TrimSpace(emoji), false, nil
	}
	key = models.ReactionKeyForCustomEmoji(id, animated)
	if r == nil {
		return key, true, nil
	}
	if err := r.ResolveForReaction(ctx, userID, id, animated); err != nil {
		if errors.Is(err, models.ErrUnknownEmoji) {
			return key, true, nil
		}
		return "", false, err
	}
	return key, false, nil
}

// SetEmojiResolver wires custom-emoji reaction validation (init_services.go).
func (s *reactionService) SetEmojiResolver(r EmojiResolver) { s.emojiResolver = r }

// SetEmojiResolver wires custom-emoji reaction validation (init_services.go).
func (s *dmService) SetEmojiResolver(r EmojiResolver) { s.emojiResolver = r }
