// Package services — the self-DM ("notes to self").
//
// A self-DM is an ordinary dm_channels row whose user1_id and user2_id are
// both the caller: migration 009 declares no CHECK against that, its
// UNIQUE(user1_id, user2_id) accepts the pair once, sortUserIDs(me, me) is
// (me, me), and broadcastToBothUsers already guards the equal-ids case so
// nothing is delivered twice. Only POST /api/dms/self creates one — the
// generic GetOrCreateChannel keeps rejecting user_id == me (dm_channel.go)
// so the regular "start a DM" path cannot stumble into it.
package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

func (s *dmService) GetOrCreateSelfChannel(ctx context.Context, userID string) (*models.DMChannelWithUser, error) {
	me, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	existing, err := s.dmRepo.GetChannelByUsers(ctx, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing self DM channel: %w", err)
	}
	if existing != nil {
		return &models.DMChannelWithUser{
			ID:            existing.ID,
			OtherUser:     models.ToPublicUser(me),
			E2EEEnabled:   existing.E2EEEnabled,
			Status:        existing.Status,
			InitiatedBy:   existing.InitiatedBy,
			CreatedAt:     existing.CreatedAt,
			LastMessageAt: existing.LastMessageAt,
		}, nil
	}

	// No privacy / friendship gate: the caller is both participants. Always
	// "accepted" — SendMessage skips the message-request transition for a
	// self channel, so it can never fall back to pending.
	channel := &models.DMChannel{
		User1ID: userID,
		User2ID: userID,
		Status:  models.DMStatusAccepted,
	}
	if err := s.dmRepo.CreateChannel(ctx, channel); err != nil {
		// Two concurrent first calls race on UNIQUE(user1_id, user2_id): the
		// loser re-reads the winner's row and answers with it, exactly as a
		// serial second call would (no broadcast — the winner sent it).
		if winner, findErr := s.dmRepo.GetChannelByUsers(ctx, userID, userID); findErr == nil && winner != nil {
			return &models.DMChannelWithUser{
				ID:            winner.ID,
				OtherUser:     models.ToPublicUser(me),
				E2EEEnabled:   winner.E2EEEnabled,
				Status:        winner.Status,
				InitiatedBy:   winner.InitiatedBy,
				CreatedAt:     winner.CreatedAt,
				LastMessageAt: winner.LastMessageAt,
			}, nil
		}
		return nil, fmt.Errorf("failed to create self DM channel: %w", err)
	}

	result := &models.DMChannelWithUser{
		ID:            channel.ID,
		OtherUser:     models.ToPublicUser(me),
		Status:        channel.Status,
		InitiatedBy:   channel.InitiatedBy,
		CreatedAt:     channel.CreatedAt,
		LastMessageAt: channel.LastMessageAt,
	}

	// One dm_channel_create to the caller's own sessions (other tabs/devices
	// pick the new channel up) — there is no second participant to notify.
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDMChannelCreate,
		Data: result,
	})

	return result, nil
}
