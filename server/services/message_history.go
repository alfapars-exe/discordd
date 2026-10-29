// Package services — channel message history: the around=/after= window
// reads next to GetByChannelID's before= form, and the batch hydration all
// three share.
package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// historyPageLimit applies GetByChannelID's clamp: out-of-range → 50.
func historyPageLimit(limit int) int {
	if limit <= 0 || limit > 100 {
		return 50
	}
	return limit
}

// checkHistoryRead is the read gate every history form shares: the channel
// must belong to serverID and the caller must hold ViewChannel +
// ReadMessages on it (override-aware).
func (s *messageService) checkHistoryRead(ctx context.Context, serverID, channelID, userID string) error {
	if _, err := s.validateChannelScope(ctx, serverID, channelID); err != nil {
		return err
	}
	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(channelPerms) {
		return fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}
	return nil
}

// GetAround returns a window centred on anchorID (ASC): has_more reports
// older rows beyond the window, has_more_after newer ones. An anchor that is
// unknown or belongs to another channel is pkg.ErrNotFound (from the repo).
func (s *messageService) GetAround(ctx context.Context, serverID, channelID, userID, anchorID string, limit int) (*models.MessagePage, error) {
	if err := s.checkHistoryRead(ctx, serverID, channelID, userID); err != nil {
		return nil, err
	}
	limit = historyPageLimit(limit)

	messages, hasMoreBefore, hasMoreAfter, err := s.messageRepo.GetByChannelIDAround(ctx, channelID, anchorID, limit)
	if err != nil {
		return nil, err
	}
	messages, err = s.hydrateMessages(ctx, messages)
	if err != nil {
		return nil, err
	}
	return &models.MessagePage{Messages: messages, HasMore: hasMoreBefore, HasMoreAfter: hasMoreAfter}, nil
}

// GetAfter returns up to limit rows strictly newer than afterID (ASC);
// has_more_after reports whether more follow, has_more is always false.
func (s *messageService) GetAfter(ctx context.Context, serverID, channelID, userID, afterID string, limit int) (*models.MessagePage, error) {
	if err := s.checkHistoryRead(ctx, serverID, channelID, userID); err != nil {
		return nil, err
	}
	limit = historyPageLimit(limit)

	// Fetch limit+1 to determine if more rows follow (same pattern as the
	// before= form).
	messages, err := s.messageRepo.GetByChannelIDAfter(ctx, channelID, afterID, limit+1)
	if err != nil {
		return nil, err
	}
	hasMoreAfter := len(messages) > limit
	if hasMoreAfter {
		messages = messages[:limit]
	}
	messages, err = s.hydrateMessages(ctx, messages)
	if err != nil {
		return nil, err
	}
	return &models.MessagePage{Messages: messages, HasMoreAfter: hasMoreAfter}, nil
}

// hydrateMessages batch-loads attachments, mentions, role mentions and
// reactions for a page (avoids N+1) and normalises every nil slice to an
// empty one so the JSON never carries null where the client expects []. A
// nil page comes back as an empty, non-nil slice for the same reason.
func (s *messageService) hydrateMessages(ctx context.Context, messages []models.Message) ([]models.Message, error) {
	if len(messages) == 0 {
		return []models.Message{}, nil
	}

	messageIDs := make([]string, len(messages))
	for i, m := range messages {
		messageIDs[i] = m.ID
	}

	attachments, err := s.attachmentRepo.GetByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments: %w", err)
	}

	attachmentMap := make(map[string][]models.Attachment)
	for _, a := range attachments {
		attachmentMap[a.MessageID] = append(attachmentMap[a.MessageID], a)
	}

	mentionMap, err := s.mentionRepo.GetByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get mentions: %w", err)
	}

	reactionMap, err := s.reactionRepo.GetByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get reactions: %w", err)
	}

	roleMentionMap, err := s.roleMentionRepo.GetByMessageIDs(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to get role mentions: %w", err)
	}

	for i := range messages {
		messages[i].Attachments = attachmentMap[messages[i].ID]
		if messages[i].Attachments == nil {
			messages[i].Attachments = []models.Attachment{}
		}
		messages[i].Mentions = mentionMap[messages[i].ID]
		if messages[i].Mentions == nil {
			messages[i].Mentions = []string{}
		}
		messages[i].RoleMentions = roleMentionMap[messages[i].ID]
		if messages[i].RoleMentions == nil {
			messages[i].RoleMentions = []string{}
		}
		messages[i].Reactions = reactionMap[messages[i].ID]
		if messages[i].Reactions == nil {
			messages[i].Reactions = []models.ReactionGroup{}
		}
	}
	if s.deliveryDB != nil {
		marks := make([]string, len(messageIDs))
		args := make([]any, len(messageIDs))
		for i, id := range messageIDs {
			marks[i] = "?"
			args[i] = id
		}
		rows, err := s.deliveryDB.QueryContext(ctx, `SELECT m.id,m.source_sequence,c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id IN (`+strings.Join(marks, ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		positions := map[string]int{}
		for i := range messages {
			positions[messages[i].ID] = i
		}
		for rows.Next() {
			var id, server string
			var seq int64
			if err = rows.Scan(&id, &seq, &server); err != nil {
				rows.Close()
				return nil, err
			}
			i := positions[id]
			messages[i].SourceSequence = seq
			messages[i].ServerID = server
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		stateRows, stateErr := s.deliveryDB.QueryContext(ctx, `SELECT message_id,file_index,filename,status,error,attachment_id FROM channel_attachment_jobs WHERE message_id IN (`+strings.Join(marks, ",")+`) ORDER BY message_id,file_index`, args...)
		if stateErr != nil {
			return nil, stateErr
		}
		for stateRows.Next() {
			var id string
			var state models.AttachmentPreparation
			var attachmentID *string
			if stateErr = stateRows.Scan(&id, &state.Index, &state.Filename, &state.Status, &state.Error, &attachmentID); stateErr != nil {
				stateRows.Close()
				return nil, stateErr
			}
			i := positions[id]
			messages[i].AttachmentStates = append(messages[i].AttachmentStates, state)
			if attachmentID != nil {
				for j := range messages[i].Attachments {
					if messages[i].Attachments[j].ID == *attachmentID {
						index := state.Index
						messages[i].Attachments[j].PreparationIndex = &index
					}
				}
			}
		}
		stateErr = stateRows.Err()
		stateRows.Close()
		if stateErr != nil {
			return nil, stateErr
		}
	}
	return messages, nil
}
