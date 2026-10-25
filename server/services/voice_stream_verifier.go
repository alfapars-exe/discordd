package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/twitchtv/twirp"
)

const streamVerificationTimeout = 5 * time.Second

// ErrScreenShareNotVisible means actor authorization and current voice state
// passed, but LiveKit does not yet expose the published participant/track.
// A fresh signed track_published webhook should be retried by its sender.
var ErrScreenShareNotVisible = errors.New("authorized screen share not visible yet")

// VerifyCurrentScreenShare confirms that the actor is still in the channel and
// that the current server-assigned LiveKit room still exposes this exact
// VIDEO/SCREEN_SHARE publication. The client IsStreaming flag is deliberately
// not consulted: it is presentation state, not provider authority.
func (s *voiceService) VerifyCurrentScreenShare(ctx context.Context, issuerInstanceID, serverID, channelID, actorID, trackSID string) (bool, error) {
	if s == nil || ctx == nil || s.channelGetter == nil || s.livekitGetter == nil || s.afkTimeoutGetter == nil || s.permResolver == nil || s.timeoutChecker == nil || s.banChecker == nil ||
		issuerInstanceID == "" || serverID == "" || channelID == "" || actorID == "" || trackSID == "" || strings.HasSuffix(actorID, "_ss") {
		return false, errors.New("screen share verifier dependencies or identifiers invalid")
	}

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return false, fmt.Errorf("load voice channel: %w", err)
	}
	if channel == nil || channel.ID != channelID || channel.ServerID != serverID || channel.Type != models.ChannelTypeVoice {
		return false, nil
	}
	member, err := s.afkTimeoutGetter.IsMember(ctx, serverID, actorID)
	if err != nil {
		return false, fmt.Errorf("verify voice server membership: %w", err)
	}
	if !member {
		return false, nil
	}
	resolver := s.permResolver
	if cached, ok := resolver.(*cachingPermResolver); ok {
		resolver = cached.inner
	}
	permissions, err := resolver.ResolveChannelPermissions(ctx, actorID, channelID)
	if err != nil {
		return false, fmt.Errorf("resolve actor voice permissions: %w", err)
	}
	if !permissions.Has(models.PermViewChannel) || !permissions.Has(models.PermConnectVoice) || !permissions.Has(models.PermStream) {
		return false, nil
	}
	timedOut, err := s.timeoutChecker.IsActive(ctx, serverID, actorID)
	if err != nil {
		return false, fmt.Errorf("verify actor timeout status: %w", err)
	}
	if timedOut {
		return false, nil
	}
	banned, err := s.banChecker.Exists(ctx, serverID, actorID)
	if err != nil {
		return false, fmt.Errorf("verify actor ban status: %w", err)
	}
	if banned {
		return false, nil
	}

	s.mu.RLock()
	state, inVoice := s.states[actorID]
	voiceStateMatches := inVoice && state != nil && state.ChannelID == channelID && state.ServerID == serverID
	s.mu.RUnlock()
	if !voiceStateMatches {
		return false, nil
	}

	instance, err := s.livekitGetter.GetByServerID(ctx, serverID)
	if err != nil {
		return false, fmt.Errorf("load current LiveKit assignment: %w", err)
	}
	if instance == nil || instance.ID != issuerInstanceID || instance.URL == "" {
		return false, nil
	}
	apiKey, err := crypto.Decrypt(instance.APIKey, s.encryptionKey)
	if err != nil || apiKey == "" {
		return false, errors.New("decrypt current LiveKit API key")
	}
	apiSecret, err := crypto.Decrypt(instance.APISecret, s.encryptionKey)
	if err != nil || apiSecret == "" {
		return false, errors.New("decrypt current LiveKit API secret")
	}

	verifyCtx, cancel := context.WithTimeout(ctx, streamVerificationTimeout)
	defer cancel()
	roomName := serverID + ":" + channelID
	room := lksdk.NewRoomServiceClient(instance.URL, apiKey, apiSecret)
	// Web screen sharing publishes on the authenticated primary participant.
	// Native Capacitor uses a distinct _ss participant, so check the primary
	// first and only fall back when the exact current track is absent there.
	main, err := room.GetParticipant(verifyCtx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: actorID})
	if err != nil {
		if isLiveKitParticipantNotFound(err) {
			return false, ErrScreenShareNotVisible
		}
		return false, fmt.Errorf("verify main LiveKit participant: %w", err)
	}
	if hasScreenShareTrack(main, trackSID) {
		return true, nil
	}
	share, err := room.GetParticipant(verifyCtx, &livekit.RoomParticipantIdentity{Room: roomName, Identity: actorID + "_ss"})
	if err != nil {
		if isLiveKitParticipantNotFound(err) {
			return false, ErrScreenShareNotVisible
		}
		return false, fmt.Errorf("verify screen-share LiveKit participant: %w", err)
	}
	if hasScreenShareTrack(share, trackSID) {
		return true, nil
	}
	return false, ErrScreenShareNotVisible
}

func hasScreenShareTrack(participant *livekit.ParticipantInfo, trackSID string) bool {
	if participant == nil || trackSID == "" {
		return false
	}
	for _, publication := range participant.GetTracks() {
		if publication != nil && publication.GetSid() == trackSID &&
			publication.GetType() == livekit.TrackType_VIDEO && publication.GetSource() == livekit.TrackSource_SCREEN_SHARE {
			return true
		}
	}
	return false
}

func isLiveKitParticipantNotFound(err error) bool {
	var twirpErr twirp.Error
	if errors.As(err, &twirpErr) {
		return twirpErr.Code() == twirp.NotFound
	}
	return false
}

var _ CurrentScreenShareVerifier = (*voiceService)(nil)
