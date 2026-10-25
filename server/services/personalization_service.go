package services

import (
	"context"
	"encoding/json"

	"github.com/argeinfina/hichat/models"
)

type personalizationUserReader interface {
	GetByID(context.Context, string) (*models.User, error)
}

type personalizationServerReader interface {
	GetUserServers(context.Context, string) ([]models.ServerListItem, error)
}

type PersonalizationService interface {
	Recommendations(context.Context, string) (*models.PersonalizationRecommendations, error)
}

type personalizationService struct {
	prefs   profilePreferenceReader
	users   personalizationUserReader
	servers personalizationServerReader
	friends profileFriendLister
}

func NewPersonalizationService(prefs profilePreferenceReader, users personalizationUserReader, servers personalizationServerReader, friends profileFriendLister) PersonalizationService {
	return &personalizationService{prefs: prefs, users: users, servers: servers, friends: friends}
}

func (s *personalizationService) Recommendations(ctx context.Context, userID string) (*models.PersonalizationRecommendations, error) {
	prefs, err := s.prefs.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	var data struct {
		Privacy struct {
			ExperiencePersonalization bool `json:"experiencePersonalization"`
		} `json:"privacy"`
	}
	if len(prefs.Data) > 0 {
		if err := json.Unmarshal(prefs.Data, &data); err != nil {
			return nil, err
		}
	}
	if !data.Privacy.ExperiencePersonalization {
		// Consent is checked before optional profile/activity inputs are read.
		return &models.PersonalizationRecommendations{Enabled: false, Items: []string{}}, nil
	}

	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	servers, err := s.servers.GetUserServers(ctx, userID)
	if err != nil {
		return nil, err
	}
	friends, err := s.friends.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}
	items := make([]string, 0, 3)
	if user.AvatarURL == nil || user.Bio == nil || *user.Bio == "" {
		items = append(items, "complete_profile")
	}
	if len(servers) == 0 {
		items = append(items, "join_server")
	}
	if len(friends) == 0 {
		items = append(items, "add_friend")
	}
	return &models.PersonalizationRecommendations{Enabled: true, Items: items}, nil
}
