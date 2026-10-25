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
	allowed := make([]models.VoiceState, 0, len(candidates))
	seen := make(map[string]bool, len(candidates))
	for _, state := range candidates {
		if ctx.Err() != nil {
			return false
		}
		if state.UserID == "" || state.JoinedAt.IsZero() || state.ChannelGeneration == 0 || state.ServerID != serverID || state.ChannelID != channelID || seen[state.UserID] {
			continue
		}
		seen[state.UserID] = true
		member, err := members.IsMember(ctx, serverID, state.UserID)
		if err != nil || !member {
			continue
		}
		permission, err := fresh.ResolveChannelPermissionsFresh(ctx, state.UserID, channelID)
		if err != nil || !permission.Has(models.PermViewChannel) {
			continue
		}
		allowed = append(allowed, state)
	}
	sent := false
	event.ServerID = serverID
	for _, expected := range allowed {
		if ctx.Err() != nil {
			return sent
		}
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
		// Send immediately after this recipient's final checks. A later
		// recipient's lookup cannot retain a previously authorized recipient;
		// revocation after queue delivery cannot recall the enqueued event.
		s.hub.BroadcastToUsers([]string{expected.UserID}, event)
		sent = true
	}
	return sent
}
