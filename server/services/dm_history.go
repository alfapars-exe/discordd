// Package services — DM message history: the around=/after= window reads
// next to GetMessages' before= form (dm_message.go).
package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// GetMessagesAround returns a window centred on anchorID (ASC) for a channel
// the caller belongs to: has_more reports older rows beyond the window,
// has_more_after newer ones. An anchor that is unknown or belongs to another
// channel is pkg.ErrNotFound (from the repo).
func (s *dmService) GetMessagesAround(ctx context.Context, userID, channelID, anchorID string, limit int) (*models.DMMessagePage, error) {
	limit = historyPageLimit(limit)
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, hasMoreBefore, hasMoreAfter, err := s.dmRepo.GetMessagesAround(ctx, channelID, anchorID, limit)
	if err != nil {
		return nil, err
	}
	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}
	if messages == nil {
		messages = []models.DMMessage{}
	}
	return &models.DMMessagePage{Messages: messages, HasMore: hasMoreBefore, HasMoreAfter: hasMoreAfter}, nil
}

// GetMessagesAfter returns up to limit rows strictly newer than afterID
// (ASC); has_more_after reports whether more follow, has_more is false.
func (s *dmService) GetMessagesAfter(ctx context.Context, userID, channelID, afterID string, limit int) (*models.DMMessagePage, error) {
	limit = historyPageLimit(limit)
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetMessagesAfter(ctx, channelID, afterID, limit+1)
	if err != nil {
		return nil, err
	}
	hasMoreAfter := len(messages) > limit
	if hasMoreAfter {
		messages = messages[:limit]
	}
	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}
	if messages == nil {
		messages = []models.DMMessage{}
	}
	return &models.DMMessagePage{Messages: messages, HasMoreAfter: hasMoreAfter}, nil
}
