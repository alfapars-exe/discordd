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
	Voice   MusicAudienceVoice
	Members MusicAudienceMembership
}
type musicAudienceFreshPermissions interface {
	ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error)
}

func (s *musicBotService) broadcastMusicAudience(serverID, channelID string, event ws.Event) bool {
	voice, members := s.audience.Voice, s.audience.Members
	fresh, ok := s.perms.(musicAudienceFreshPermissions)
	if voice == nil || members == nil || !ok || s.channels == nil || s.hub == nil {
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
		member, err := members.IsMember(ctx, serverID, expected.UserID)
		if err != nil || !member {
			continue
		}
		permission, err := fresh.ResolveChannelPermissionsFresh(ctx, expected.UserID, channelID)
		if err != nil || !permission.Has(models.PermViewChannel) {
			continue
		}
		current := voice.GetUserVoiceState(expected.UserID)
		if current == nil || current.ServerID != serverID || current.ChannelID != channelID || !current.JoinedAt.Equal(expected.JoinedAt) || current.ChannelGeneration != expected.ChannelGeneration || ctx.Err() != nil {
			continue
		}
		// Authorize once immediately before this recipient's enqueue; no
		// preliminary database read is reused. A later recipient's lookup
		// cannot retroactively recall an already authorized enqueued event.
		s.hub.BroadcastToUsers([]string{expected.UserID}, event)
		sent = true
	}
	return sent
}
