package handlers

import (
	"context"
	"net/http"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type MusicSessionValidator interface {
	ValidateSession(context.Context, string, string) error
}
type MusicServerMembership interface {
	IsMember(context.Context, string, string) (bool, error)
}
type musicVoiceSessionSource interface {
	GetUserVoiceState(string) *models.VoiceState
}
type musicFreshPermissionResolver interface {
	ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error)
}

func (h *MusicHandler) musicAccessContext(r *http.Request, userID, channelID string, required models.Permission) (context.Context, error) {
	serverID := r.PathValue("serverId")
	sid, _ := r.Context().Value(AuthSessionContextKey).(string)
	var joinedAt time.Time
	var channelGeneration uint64
	voiceSource, hasVoiceSession := h.access.Voice.(musicVoiceSessionSource)
	bindVoice := required != models.PermManageChannels && required != models.PermViewChannel
	if bindVoice && hasVoiceSession {
		state := voiceSource.GetUserVoiceState(userID)
		if state == nil || state.ChannelID != channelID || state.ServerID != serverID || state.JoinedAt.IsZero() {
			return nil, pkg.ErrForbidden
		}
		joinedAt = state.JoinedAt
		channelGeneration = state.ChannelGeneration
	}
	check := func(ctx context.Context) error {
		if h.access.Sessions != nil {
			if err := h.access.Sessions.ValidateSession(ctx, userID, sid); err != nil {
				return err
			}
		}
		if h.access.Members != nil {
			member, err := h.access.Members.IsMember(ctx, serverID, userID)
			if err != nil {
				return err
			}
			if !member {
				return pkg.ErrForbidden
			}
		}
		if h.access.Channels != nil {
			channel, err := h.access.Channels.GetByID(ctx, channelID)
			if err != nil {
				return err
			}
			if channel.Type != models.ChannelTypeVoice || channel.ServerID != serverID {
				return pkg.ErrForbidden
			}
		}
		var effective models.Permission
		var err error
		if fresh, ok := h.perms.(musicFreshPermissionResolver); ok {
			effective, err = fresh.ResolveChannelPermissionsFresh(ctx, userID, channelID)
		} else {
			effective, err = h.perms.ResolveChannelPermissions(ctx, userID, channelID)
		}
		if err != nil {
			return err
		}
		if !effective.Has(required) || !effective.Has(models.PermViewChannel) {
			return pkg.ErrForbidden
		}
		if bindVoice && h.access.Voice != nil {
			if hasVoiceSession {
				state := voiceSource.GetUserVoiceState(userID)
				if state == nil || state.ChannelID != channelID || state.ServerID != serverID || !state.JoinedAt.Equal(joinedAt) || state.ChannelGeneration != channelGeneration {
					return pkg.ErrForbidden
				}
			} else if h.access.Voice.GetUserVoiceChannelID(userID) != channelID {
				return pkg.ErrForbidden
			}
		}
		return nil
	}
	return services.WithMusicAccessCheck(r.Context(), check), nil
}
