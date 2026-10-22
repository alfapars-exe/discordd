// Package services — DM request (message-request flow).
// A channel transitions from accepted → pending when a non-friend sends the
// first message to someone with `message_request` privacy. Only the recipient
// (non-initiator) can accept or decline.
package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

func (s *dmService) AcceptRequest(ctx context.Context, userID, channelID string) error {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return err
	}

	if channel.Status != models.DMStatusPending {
		return fmt.Errorf("%w: channel is not pending", pkg.ErrBadRequest)
	}

	// Only the recipient (non-initiator) can accept
	if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
		return fmt.Errorf("%w: only the recipient can accept a DM request", pkg.ErrForbidden)
	}

	if err := s.dmRepo.UpdateChannelStatus(ctx, channelID, models.DMStatusAccepted); err != nil {
		return fmt.Errorf("failed to accept DM request: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMRequestAccept,
		Data: map[string]string{
			"dm_channel_id": channelID,
		},
	})

	// The accepting recipient's dm_request inbox row is now stale
	// (best-effort, see settleRequestNotifications).
	ids, markErr := s.notificationRepo.MarkDMRequestRead(ctx, userID, channelID)
	settleRequestNotifications(ctx, s.notificationRepo, s.hub, userID, ids, markErr)

	return nil
}

func (s *dmService) DeclineRequest(ctx context.Context, userID, channelID string) error {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return err
	}

	if channel.Status != models.DMStatusPending {
		return fmt.Errorf("%w: channel is not pending", pkg.ErrBadRequest)
	}

	// Only the recipient can decline
	if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
		return fmt.Errorf("%w: only the recipient can decline a DM request", pkg.ErrForbidden)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMRequestDecline,
		Data: map[string]string{
			"dm_channel_id": channelID,
		},
	})

	// Retire the recipient's dm_request inbox row BEFORE DeleteChannel
	// removes every notification on this channel: marking first yields the
	// ids for the notification_read push, and the unread count it carries
	// already excludes them (best-effort, see settleRequestNotifications).
	ids, markErr := s.notificationRepo.MarkDMRequestRead(ctx, userID, channelID)
	settleRequestNotifications(ctx, s.notificationRepo, s.hub, userID, ids, markErr)

	// Pre-fetch attachment file_urls for the post-delete disk cleanup below.
	// A fetch failure here is logged and non-fatal — the decline still
	// proceeds, it just can't clean up files it couldn't enumerate.
	fileURLs, urlErr := s.dmRepo.GetAttachmentFileURLsByChannelID(ctx, channelID)
	if urlErr != nil {
		dmLogger.Error("failed to fetch DM attachment file urls before channel delete", "channel_id", channelID, "err", pkg.ErrText(urlErr))
	}

	if err := s.dmRepo.DeleteChannel(ctx, channelID); err != nil {
		return fmt.Errorf("failed to decline DM request: %w", err)
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	removeUploadFilesByURL(s.uploadDir, fileURLs)

	return nil
}

// AcceptPendingChannels auto-accepts pending DMs when two users become friends.
func (s *dmService) AcceptPendingChannels(ctx context.Context, userA, userB string) error {
	u1, u2 := sortUserIDs(userA, userB)
	ch, err := s.dmRepo.GetChannelByUsers(ctx, u1, u2)
	if err != nil || ch == nil {
		return nil // no channel exists, nothing to do
	}
	if ch.Status != models.DMStatusPending {
		return nil
	}

	if err := s.dmRepo.UpdateChannelStatus(ctx, ch.ID, models.DMStatusAccepted); err != nil {
		return fmt.Errorf("failed to auto-accept pending DM: %w", err)
	}

	s.broadcastToBothUsers(ch, ws.Event{
		Op: ws.OpDMRequestAccept,
		Data: map[string]string{
			"dm_channel_id": ch.ID,
		},
	})

	// Only the non-initiator holds a dm_request row, but InitiatedBy can be
	// NULL on legacy rows, so settle both sides — the initiator's call
	// matches nothing and pushes nothing.
	for _, uid := range []string{u1, u2} {
		ids, markErr := s.notificationRepo.MarkDMRequestRead(ctx, uid, ch.ID)
		settleRequestNotifications(ctx, s.notificationRepo, s.hub, uid, ids, markErr)
	}

	return nil
}
