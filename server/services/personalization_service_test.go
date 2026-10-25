package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type personalizationPrefsStub struct{ enabled bool }

func (s personalizationPrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	data, _ := json.Marshal(map[string]any{"privacy": map[string]any{"experiencePersonalization": s.enabled}})
	return &models.UserPreferences{Data: data}, nil
}

type personalizationUsersStub struct {
	called bool
	user   *models.User
}

func (s *personalizationUsersStub) GetByID(context.Context, string) (*models.User, error) {
	s.called = true
	return s.user, nil
}

type personalizationServersStub struct {
	called  bool
	servers []models.ServerListItem
}

func (s *personalizationServersStub) GetUserServers(context.Context, string) ([]models.ServerListItem, error) {
	s.called = true
	return s.servers, nil
}

type personalizationFriendsStub struct {
	called  bool
	friends []models.FriendshipWithUser
}

func (s *personalizationFriendsStub) ListFriends(context.Context, string) ([]models.FriendshipWithUser, error) {
	s.called = true
	return s.friends, nil
}

func TestPersonalizationDisabledDoesNotReadOptionalInputs(t *testing.T) {
	users := &personalizationUsersStub{user: &models.User{ID: "u1"}}
	servers := &personalizationServersStub{}
	friends := &personalizationFriendsStub{}
	service := NewPersonalizationService(personalizationPrefsStub{enabled: false}, users, servers, friends)
	result, err := service.Recommendations(context.Background(), "u1")
	if err != nil {
		t.Fatalf("Recommendations: %v", err)
	}
	if result.Enabled || len(result.Items) != 0 {
		t.Fatalf("result = %+v, want disabled and empty", result)
	}
	if users.called || servers.called || friends.called {
		t.Fatalf("optional inputs were read while consent was off: user=%v servers=%v friends=%v", users.called, servers.called, friends.called)
	}
}

func TestPersonalizationEnabledUsesProfileAndActivityInputs(t *testing.T) {
	users := &personalizationUsersStub{user: &models.User{ID: "u1"}}
	servers := &personalizationServersStub{}
	friends := &personalizationFriendsStub{}
	service := NewPersonalizationService(personalizationPrefsStub{enabled: true}, users, servers, friends)
	result, err := service.Recommendations(context.Background(), "u1")
	if err != nil {
		t.Fatalf("Recommendations: %v", err)
	}
	want := []string{"complete_profile", "join_server", "add_friend"}
	if !result.Enabled || len(result.Items) != len(want) {
		t.Fatalf("result = %+v, want enabled items %v", result, want)
	}
	for i := range want {
		if result.Items[i] != want[i] {
			t.Fatalf("items = %v, want %v", result.Items, want)
		}
	}
	if !users.called || !servers.called || !friends.called {
		t.Fatalf("enabled personalization did not read all inputs")
	}
}
