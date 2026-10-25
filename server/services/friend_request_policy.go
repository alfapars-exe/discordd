package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/pkg"
)

type friendRequestServerReader interface {
	GetMemberServerIDs(context.Context, string) ([]string, error)
}

type FriendRequestPolicy interface {
	CanSend(context.Context, string, string) (bool, error)
}

// RepositoryFriendRequestPolicy is the production adapter boundary. It is
// intentionally expressed through functions so repository interfaces do not
// need policy-only methods or wrapper return types.
type RepositoryFriendRequestPolicy struct {
	prefs       profilePreferenceReader
	listFriends func(context.Context, string) ([]string, error)
	areFriends  func(context.Context, string, string) (bool, error)
	servers     friendRequestServerReader
}

func NewFriendRequestPolicy(
	prefs profilePreferenceReader,
	listFriends func(context.Context, string) ([]string, error),
	areFriends func(context.Context, string, string) (bool, error),
	servers friendRequestServerReader,
) FriendRequestPolicy {
	return &RepositoryFriendRequestPolicy{prefs: prefs, listFriends: listFriends, areFriends: areFriends, servers: servers}
}

func (p *RepositoryFriendRequestPolicy) CanSend(ctx context.Context, senderID, targetID string) (bool, error) {
	preferences, err := p.prefs.Get(ctx, targetID)
	if err != nil {
		return false, err
	}
	rules := struct {
		Privacy struct {
			FriendRequests *struct {
				Everyone bool `json:"everyone"`
				Mutual   bool `json:"mutual"`
				Server   bool `json:"server"`
			} `json:"friendRequests"`
		} `json:"privacy"`
	}{}
	// Existing accounts predate these preferences. Preserve their current
	// behavior by defaulting to everyone until the owner explicitly saves a
	// stricter combination.
	if len(preferences.Data) > 0 {
		if err := json.Unmarshal(preferences.Data, &rules); err != nil {
			return false, fmt.Errorf("%w: invalid stored friend-request preferences", pkg.ErrInternal)
		}
	}
	if rules.Privacy.FriendRequests == nil || rules.Privacy.FriendRequests.Everyone {
		return true, nil
	}
	if rules.Privacy.FriendRequests.Mutual {
		ids, err := p.listFriends(ctx, targetID)
		if err != nil {
			return false, err
		}
		for _, id := range ids {
			accepted, err := p.areFriends(ctx, senderID, id)
			if err != nil {
				return false, err
			}
			if accepted {
				return true, nil
			}
		}
	}
	if rules.Privacy.FriendRequests.Server {
		// Both criteria must come from one preference revision, not two reads
		// that can straddle an account's concurrent privacy update.
		serverDMPrefs, err := parseServerDMPreferences(preferences.Data)
		if err != nil {
			return false, err
		}
		senderServers, err := p.servers.GetMemberServerIDs(ctx, senderID)
		if err != nil {
			return false, err
		}
		targetServers, err := p.servers.GetMemberServerIDs(ctx, targetID)
		if err != nil {
			return false, err
		}
		_, allowed := sharedAllowedServer(senderServers, targetServers, serverDMPrefs)
		if allowed {
			return true, nil
		}
	}
	return false, nil
}
