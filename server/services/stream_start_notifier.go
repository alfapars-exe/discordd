package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const streamStartRecipientLimit = 200
const streamStartFanoutTimeout = 15 * time.Second
const streamStartPublicationMaxAge = 2 * time.Minute
const streamStartPublicationFutureSkew = 30 * time.Second

// CurrentScreenShareVerifier checks provider state rather than trusting the
// client-facing IsStreaming voice-state bit.
type CurrentScreenShareVerifier interface {
	VerifyCurrentScreenShare(ctx context.Context, issuerInstanceID, serverID, channelID, actorID, trackSID string) (bool, error)
}

// StreamStartNotifier is the narrow webhook-facing capability for a verified
// track_published event.
type StreamStartNotifier interface {
	// publicationTime is the signed LiveKit event's created_at timestamp. The
	// service uses its own current clock for delivery timestamps and retry-age
	// checks; this value must never be substituted for database delivery time.
	NotifyStreamStart(ctx context.Context, issuerInstanceID, serverID, channelID, actorID, roomName, trackSID string, publicationTime time.Time) error
}

type streamStartNotifier struct {
	repo     repository.StreamStartNotificationRepository
	verifier CurrentScreenShareVerifier
	hub      ws.Broadcaster
	clock    func() time.Time
}

func NewStreamStartNotifier(repo repository.StreamStartNotificationRepository, verifier CurrentScreenShareVerifier, hub ws.Broadcaster) StreamStartNotifier {
	return &streamStartNotifier{repo: repo, verifier: verifier, hub: hub, clock: time.Now}
}

func (s *streamStartNotifier) NotifyStreamStart(ctx context.Context, issuerInstanceID, serverID, channelID, actorID, roomName, trackSID string, publicationTime time.Time) error {
	if s == nil || s.repo == nil || s.verifier == nil || s.hub == nil || ctx == nil ||
		issuerInstanceID == "" || serverID == "" || channelID == "" || actorID == "" || trackSID == "" ||
		roomName != serverID+":"+channelID {
		return errors.New("stream start notification dependencies or identifiers invalid")
	}
	if s.clock == nil {
		return errors.New("stream start notification clock unavailable")
	}
	fanoutCtx, cancel := context.WithTimeout(ctx, streamStartFanoutTimeout)
	defer cancel()
	now := s.clock().UTC()
	if !IsFreshStreamPublication(publicationTime, now) {
		return nil
	}
	valid, err := s.verifier.VerifyCurrentScreenShare(fanoutCtx, issuerInstanceID, serverID, channelID, actorID, trackSID)
	if err != nil {
		return fmt.Errorf("verify current screen share: %w", err)
	}
	if !valid {
		return nil
	}
	publicationID := streamPublicationID(issuerInstanceID, roomName, trackSID)
	recipients, err := s.repo.DueRecipients(fanoutCtx, publicationID, serverID, actorID, streamStartRecipientLimit)
	if err != nil {
		return fmt.Errorf("list stream start recipients: %w", err)
	}
	if len(recipients) > streamStartRecipientLimit {
		return fmt.Errorf("stream start repository exceeded recipient bound")
	}
	var deliveryErrors []error
	for _, recipientID := range recipients {
		if recipientID == "" || recipientID == actorID {
			continue
		}
		now = s.clock().UTC()
		if !IsFreshStreamPublication(publicationTime, now) {
			break
		}
		// Re-query provider state during fanout so a long recipient loop does
		// not continue advertising a screen share after it has stopped. This
		// provider read and the SQL commit cannot be one atomic transaction; a
		// stop immediately after this check can still race one individual write.
		valid, err = s.verifier.VerifyCurrentScreenShare(fanoutCtx, issuerInstanceID, serverID, channelID, actorID, trackSID)
		if err != nil {
			deliveryErrors = append(deliveryErrors, fmt.Errorf("verify stream before delivery: %w", err))
			break
		}
		if !valid {
			break
		}
		now = s.clock().UTC()
		if !IsFreshStreamPublication(publicationTime, now) {
			break
		}
		notification, err := s.repo.Deliver(fanoutCtx, publicationID, roomName, trackSID, serverID, channelID, actorID, recipientID, now)
		if err != nil {
			deliveryErrors = append(deliveryErrors, fmt.Errorf("deliver stream start notification: %w", err))
			continue
		}
		if notification != nil {
			broadcastNotificationCreate(s.hub, notification)
		}
	}
	return errors.Join(deliveryErrors...)
}

// IsFreshStreamPublication bounds retries for provider-side visibility races.
// Timestamps outside this window are acknowledged without trying notification
// work, avoiding retries for old/stopped publications or implausible clocks.
func IsFreshStreamPublication(publicationTime, now time.Time) bool {
	if publicationTime.IsZero() || now.IsZero() || publicationTime.After(now.Add(streamStartPublicationFutureSkew)) {
		return false
	}
	return now.Sub(publicationTime) <= streamStartPublicationMaxAge
}

func streamPublicationID(instanceID, roomName, trackSID string) string {
	value := strings.Join([]string{instanceID, roomName, trackSID}, "\x00")
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

var _ StreamStartNotifier = (*streamStartNotifier)(nil)
