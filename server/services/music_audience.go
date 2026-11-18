package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

type MusicAudienceVoice interface {
	GetChannelParticipants(string) []models.VoiceState
	GetUserVoiceState(string) *models.VoiceState
}
type MusicAudienceMembership interface {
	IsMember(context.Context, string, string) (bool, error)
}

// MusicAudienceDependencies are trusted server dependencies, never client recipients.
// Missing dependencies fail closed; HTTP View-only state reads use their own gate.
type MusicAudienceDependencies struct {
	Voice            MusicAudienceVoice
	Members          MusicAudienceMembership
	FreshPermissions MusicAudienceFreshPermissions
}
type MusicAudienceFreshPermissions interface {
	ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error)
}

type musicPublisher struct {
	bot   *botInstance
	final bool
	fatal bool
}

// Called under the service read lock immediately before enqueue.
func (p musicPublisher) ownsDelivery(current *botInstance) bool {
	if p.final {
		return current == nil || current == p.bot
	}
	return current == p.bot && (p.fatal || !p.bot.stopping.Load())
}

func musicAudienceRecipientCurrent(ctx context.Context, expected models.VoiceState, voice MusicAudienceVoice, members MusicAudienceMembership, fresh MusicAudienceFreshPermissions) bool {
	member, err := members.IsMember(ctx, expected.ServerID, expected.UserID)
	if err != nil || !member {
		return false
	}
	permission, err := fresh.ResolveChannelPermissionsFresh(ctx, expected.UserID, expected.ChannelID)
	if err != nil || !permission.Has(models.PermViewChannel) {
		return false
	}
	current := voice.GetUserVoiceState(expected.UserID)
	return current != nil && current.ServerID == expected.ServerID && current.ChannelID == expected.ChannelID && current.JoinedAt.Equal(expected.JoinedAt) && current.ChannelGeneration == expected.ChannelGeneration && ctx.Err() == nil
}

func (s *musicBotService) enqueueMusicAudienceRecipient(channelID, userID string, event ws.Event, publisher *musicPublisher) bool {
	if publisher != nil {
		s.mu.RLock()
		if !publisher.ownsDelivery(s.bots[channelID]) {
			s.mu.RUnlock()
			return false
		}
		s.hub.BroadcastToUsers([]string{userID}, event)
		s.mu.RUnlock()
	} else {
		s.hub.BroadcastToUsers([]string{userID}, event)
	}
	return true
}

func (s *musicBotService) broadcastMusicAudience(serverID, channelID string, event ws.Event, publisher *musicPublisher) bool {
	voice, members := s.audience.Voice, s.audience.Members
	fresh := s.audience.FreshPermissions
	if voice == nil || members == nil || fresh == nil || s.channels == nil || s.hub == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
	defer cancel()
	channel, err := s.channels.GetByID(ctx, channelID)
	if err != nil || channel == nil || channel.ServerID != serverID || channel.Type != models.ChannelTypeVoice {
		return false
	}
	candidates := voice.GetChannelParticipants(channelID)
	seen := make(map[string]bool, len(candidates))
	sent := false
	event.ServerID = serverID
	for _, expected := range candidates {
		if ctx.Err() != nil {
			return sent
		}
		if expected.UserID == "" || expected.JoinedAt.IsZero() || expected.ChannelGeneration == 0 || expected.ServerID != serverID || expected.ChannelID != channelID || seen[expected.UserID] {
			continue
		}
		seen[expected.UserID] = true
		if !musicAudienceRecipientCurrent(ctx, expected, voice, members, fresh) {
			continue
		}
		// Authorize once immediately before this recipient's enqueue; no
		// preliminary database read is reused. A later recipient's lookup
		// cannot retroactively recall an already authorized enqueued event.
		if !s.enqueueMusicAudienceRecipient(channelID, expected.UserID, event, publisher) {
			return sent
		}
		sent = true
	}
	return sent
}
