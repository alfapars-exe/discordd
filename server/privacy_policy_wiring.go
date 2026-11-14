package main

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/services"
)

type gameActivityHubPresence interface{ IsVisibleOnline(string) (bool, error) }
type gameActivityPresenceAdapter struct{ hub gameActivityHubPresence }

func (a gameActivityPresenceAdapter) IsVisibleOnline(_ context.Context, userID string) (bool, error) {
	if a.hub == nil {
		return false, errors.New("hub presence reader unavailable")
	}
	return a.hub.IsVisibleOnline(userID)
}

type privacyPolicies struct {
	Profile        services.ProfileAudienceServicePolicy
	GameActivity   services.GameActivityPrivacyPolicy
	FriendRequests services.FriendRequestPolicy
	ServerDM       services.ServerDMPolicy
	FriendGraph    friendRequestGraphAdapter
}

// initPrivacyPolicies binds account and relationship policy readers as one domain.
func initPrivacyPolicies(repos *Repositories, presence gameActivityHubPresence) privacyPolicies {
	graph := friendRequestGraphAdapter{reader: repos.Friendship}
	return privacyPolicies{
		Profile:        services.NewProfileAudiencePolicy(repos.Preferences, repos.Friendship, repos.Server),
		GameActivity:   services.NewGameActivityPrivacyPolicy(repos.Preferences, repos.Friendship, repos.Server, repos.Server, gameActivityPresenceAdapter{hub: presence}, repos.Ban),
		FriendRequests: services.NewFriendRequestPolicy(repos.Preferences, graph.listFriendIDs, graph.AreFriends, repos.Server),
		ServerDM:       services.NewServerDMPolicy(repos.Preferences, repos.Server),
		FriendGraph:    graph,
	}
}
