package services

import (
	"context"
	"errors"

	"github.com/argeinfina/hichat/models"
)

// VoiceStateVisibilityFilter removes active voice states the viewer is not
// authorized to see. Callers provide the server IDs the viewer belongs to;
// the filter still checks actual channel ownership and effective ViewChannel
// permission before returning any state.
type VoiceStateVisibilityFilter interface {
	FilterVisibleVoiceStates(ctx context.Context, viewerID string, serverIDs []string, states []models.VoiceState) ([]models.VoiceState, error)
}

type voiceStatePermissionMapper interface {
	ResolveUserChannelPermissions(ctx context.Context, userID, serverID string) (*UserChannelPermissions, error)
}

type voiceStateChannelLister interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
}

type voiceStateMembershipChecker interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

type voiceStateVisibilityFilter struct {
	permissions voiceStatePermissionMapper
	channels    voiceStateChannelLister
	membership  voiceStateMembershipChecker
}

func NewVoiceStateVisibilityFilter(permissions voiceStatePermissionMapper, channels voiceStateChannelLister, membership voiceStateMembershipChecker) VoiceStateVisibilityFilter {
	return &voiceStateVisibilityFilter{permissions: permissions, channels: channels, membership: membership}
}

func (f *voiceStateVisibilityFilter) FilterVisibleVoiceStates(ctx context.Context, viewerID string, serverIDs []string, states []models.VoiceState) ([]models.VoiceState, error) {
	if viewerID == "" {
		return nil, errors.New("voice state visibility: viewer ID is required")
	}
	if f == nil || f.permissions == nil || f.channels == nil || f.membership == nil {
		return nil, errors.New("voice state visibility: dependencies are unavailable")
	}

	allowedServers := make(map[string]struct{}, len(serverIDs))
	for _, serverID := range serverIDs {
		if serverID != "" {
			allowedServers[serverID] = struct{}{}
		}
	}
	if len(allowedServers) == 0 || len(states) == 0 {
		return []models.VoiceState{}, nil
	}

	neededServers := make(map[string]struct{})
	for _, state := range states {
		if _, ok := allowedServers[state.ServerID]; ok && state.ChannelID != "" {
			neededServers[state.ServerID] = struct{}{}
		}
	}

	visibleChannelsByServer := make(map[string]map[string]struct{}, len(neededServers))
	var filterErr error
	processedServers := make(map[string]struct{}, len(neededServers))
	for _, serverID := range serverIDs {
		if _, needed := neededServers[serverID]; !needed {
			continue
		}
		if _, processed := processedServers[serverID]; processed {
			continue
		}
		processedServers[serverID] = struct{}{}

		isMember, err := f.membership.IsMember(ctx, serverID, viewerID)
		if err != nil {
			filterErr = errors.Join(filterErr, err)
			continue
		}
		if !isMember {
			continue
		}

		channels, err := f.channels.GetAllByServer(ctx, serverID)
		if err != nil {
			filterErr = errors.Join(filterErr, err)
			continue
		}
		voiceChannels := make(map[string]struct{}, len(channels))
		for _, channel := range channels {
			if channel.ServerID == serverID && channel.Type == models.ChannelTypeVoice {
				voiceChannels[channel.ID] = struct{}{}
			}
		}

		permissions, err := f.permissions.ResolveUserChannelPermissions(ctx, viewerID, serverID)
		if err != nil {
			filterErr = errors.Join(filterErr, err)
			continue
		}
		if permissions == nil {
			filterErr = errors.Join(filterErr, errors.New("voice state visibility: permission result is unavailable"))
			continue
		}

		for channelID := range voiceChannels {
			if permissions.Effective(channelID).Has(models.PermViewChannel) {
				if visibleChannelsByServer[serverID] == nil {
					visibleChannelsByServer[serverID] = make(map[string]struct{})
				}
				visibleChannelsByServer[serverID][channelID] = struct{}{}
			}
		}
	}

	visible := make([]models.VoiceState, 0, len(states))
	for _, state := range states {
		if _, allowed := visibleChannelsByServer[state.ServerID][state.ChannelID]; allowed {
			visible = append(visible, state)
		}
	}
	return visible, filterErr
}
