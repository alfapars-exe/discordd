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
	"github.com/argeinfina/hichat/repository"
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

	// A pending request without a valid channel-member initiator cannot
	// establish which participant is the recipient. Fail closed rather than
	// allowing either participant to accept a malformed/legacy row.
	if err := verifyDMRequestRecipient(channel, userID, "accept"); err != nil {
		return err
	}
	if err := s.verifyRequestNotBlocked(ctx, channel); err != nil {
		return err
	}

	if err := s.acceptPendingStatus(ctx, channelID); err != nil {
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

	if err := verifyDMRequestRecipient(channel, userID, "decline"); err != nil {
		return err
	}
	decliner, ok := s.dmRepo.(repository.PendingDMDecliner)
	if !ok {
		// An unconditional legacy DeleteChannel fallback would recreate the
		// accept/decline data-loss race. Do not imply it is safe.
		return fmt.Errorf("%w: atomic pending DM decline is unavailable", pkg.ErrInternal)
	}
	changed, fileURLs, ids, err := decliner.DeclinePending(ctx, channelID, userID)
	if err != nil {
		return fmt.Errorf("failed to decline DM request: %w", err)
	}
	if !changed {
		return fmt.Errorf("%w: DM request changed before decline", pkg.ErrConflict)
	}

	// The repository commits the channel and notification deletion atomically.
	// Publish only after commit, using the exact unread ids captured in that
	// transaction, then remove files whose attachment rows were committed away.
	s.broadcastToBothUsers(channel, ws.Event{
		Op:   ws.OpDMRequestDecline,
		Data: map[string]string{"dm_channel_id": channelID},
	})
	settleRequestNotifications(ctx, s.notificationRepo, s.hub, userID, ids, nil)

	removeUploadFilesByURL(s.uploadDir, fileURLs)

	return nil
}

func verifyDMRequestRecipient(channel *models.DMChannel, userID, action string) error {
	if channel.InitiatedBy == nil || *channel.InitiatedBy == "" ||
		(*channel.InitiatedBy != channel.User1ID && *channel.InitiatedBy != channel.User2ID) {
		return fmt.Errorf("%w: cannot %s DM request with unknown initiator", pkg.ErrForbidden, action)
	}
	if *channel.InitiatedBy == userID {
		return fmt.Errorf("%w: only the recipient can %s a DM request", pkg.ErrForbidden, action)
	}
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
	if err := s.verifyRequestNotBlocked(ctx, ch); err != nil {
		return err
	}

	if err := s.acceptPendingStatus(ctx, ch.ID); err != nil {
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

func (s *dmService) acceptPendingStatus(ctx context.Context, channelID string) error {
	if writer, ok := s.dmRepo.(repository.PendingDMAccepter); ok {
		changed, err := writer.AcceptPendingUnblocked(ctx, channelID)
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("%w: DM request changed or blocked", pkg.ErrConflict)
		}
		return nil
	}
	return s.dmRepo.UpdateChannelStatus(ctx, channelID, models.DMStatusAccepted)
}

func (s *dmService) verifyRequestNotBlocked(ctx context.Context, channel *models.DMChannel) error {
	if s.blockChecker == nil {
		return nil
	}
	blocked, err := s.blockChecker.IsBlocked(ctx, channel.User1ID, channel.User2ID)
	if err != nil {
		return err
	}
	if blocked {
		return fmt.Errorf("%w: cannot accept a blocked DM request", pkg.ErrForbidden)
	}
	return nil
}
