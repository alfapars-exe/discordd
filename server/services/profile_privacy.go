package services

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const smallProfileAudienceServerMax = 200

type profilePreferenceReader interface {
	Get(context.Context, string) (*models.UserPreferences, error)
}

type profileFriendshipReader interface {
	GetByPair(context.Context, string, string) (*models.Friendship, error)
}

type profileServerReader interface {
	GetUserServers(context.Context, string) ([]models.ServerListItem, error)
	GetMemberCount(context.Context, string) (int, error)
}

// ProfileAudiencePolicy enforces the target user's account-scoped profile
// audience. It is deliberately server-side; hiding controls in the client is
// not an authorization boundary.
type ProfileAudiencePolicy interface {
	CanView(context.Context, string, string) (bool, error)
}

type profileAudiencePolicy struct {
	prefs   profilePreferenceReader
	friends profileFriendshipReader
	servers profileServerReader
}

func NewProfileAudiencePolicy(prefs profilePreferenceReader, friends profileFriendshipReader, servers profileServerReader) ProfileAudiencePolicy {
	return &profileAudiencePolicy{prefs: prefs, friends: friends, servers: servers}
}

func (p *profileAudiencePolicy) CanView(ctx context.Context, viewerID, targetID string) (bool, error) {
	if viewerID == "" || targetID == "" {
		return false, errors.New("profile audience: viewer and target IDs are required")
	}
	if viewerID == targetID {
		return true, nil
	}
	if p.prefs == nil || p.friends == nil || p.servers == nil {
		return false, errors.New("profile audience: required reader is unavailable")
	}

	audience := "all_servers"
	prefs, err := p.prefs.Get(ctx, targetID)
	if err != nil {
		return false, err
	}
	if prefs == nil || !validPreferenceData(prefs.Data) {
		return false, errors.New("profile audience: invalid target preferences")
	}
	var data struct {
		Privacy struct {
			ProfileAudience string `json:"profileAudience"`
		} `json:"privacy"`
	}
	if len(prefs.Data) > 0 {
		if err := json.Unmarshal(prefs.Data, &data); err != nil {
			return false, err
		}
		if data.Privacy.ProfileAudience != "" {
			audience = data.Privacy.ProfileAudience
		}
	}

	friendship, err := p.friends.GetByPair(ctx, viewerID, targetID)
	if err == nil && friendship != nil && friendship.Status == models.FriendshipStatusAccepted {
		return true, nil
	}
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return false, err
	}
	if audience == "friends_only" {
		return false, nil
	}

	viewerServers, err := p.servers.GetUserServers(ctx, viewerID)
	if err != nil {
		return false, err
	}
	targetServers, err := p.servers.GetUserServers(ctx, targetID)
	if err != nil {
		return false, err
	}
	targetSet := make(map[string]struct{}, len(targetServers))
	for _, server := range targetServers {
		targetSet[server.ID] = struct{}{}
	}
	for _, server := range viewerServers {
		if _, shared := targetSet[server.ID]; !shared {
			continue
		}
		if audience == "all_servers" {
			return true, nil
		}
		if audience == "small_servers" {
			count, err := p.servers.GetMemberCount(ctx, server.ID)
			if err != nil {
				return false, err
			}
			if count <= smallProfileAudienceServerMax {
				return true, nil
			}
		}
	}
	return false, nil
}
