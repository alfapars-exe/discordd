package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

func (s *groupDMService) SetMuted(ctx context.Context, groupID, userID string, muted bool, expectedEpoch ...int64) (*models.GroupDMReadState, error) {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	state, err := s.groups.SetMuted(ctx, groupID, userID, muted, expectedEpoch...)
	if err != nil {
		return nil, err
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMRead, Data: state})
	return state, nil
}
