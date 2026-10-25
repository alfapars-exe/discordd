package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

func (s *groupDMService) SetMessagePinned(ctx context.Context, groupID, userID, messageID string, pinned bool) error {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return err
	}
	if err := s.groups.SetMessagePinned(ctx, groupID, messageID, userID, pinned); err != nil {
		return err
	}
	if s.hub != nil {
		ids, err := s.groups.ListMemberIDs(ctx, groupID)
		if err == nil {
			s.hub.BroadcastToUsers(ids, ws.Event{Op: ws.OpGroupDMPinsUpdate, Data: map[string]any{"group_id": groupID, "message_id": messageID, "pinned": pinned}})
		}
	}
	return nil
}

func (s *groupDMService) ListPinnedMessages(ctx context.Context, groupID, userID string) ([]models.GroupDMMessage, error) {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	items, err := s.groups.ListPinnedMessages(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if err = s.enrichMessageHistory(ctx, items); err != nil {
		return nil, err
	}
	return items, nil
}
