package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type profilePrefsStub struct{ audience string }

func (s profilePrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	return &models.UserPreferences{Data: []byte(fmt.Sprintf(`{"privacy":{"profileAudience":%q}}`, s.audience))}, nil
}

type profileFriendsStub struct{ accepted bool }

func (s profileFriendsStub) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	if !s.accepted {
		return nil, fmt.Errorf("%w: no relationship", pkg.ErrNotFound)
	}
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}

type profileServersStub struct {
	byUser map[string][]models.ServerListItem
	counts map[string]int
}

func (s profileServersStub) GetUserServers(_ context.Context, userID string) ([]models.ServerListItem, error) {
	return s.byUser[userID], nil
}

func (s profileServersStub) GetMemberCount(_ context.Context, serverID string) (int, error) {
	return s.counts[serverID], nil
}

func TestProfileAudiencePolicy(t *testing.T) {
	shared := map[string][]models.ServerListItem{
		"viewer": {{ID: "shared"}},
		"target": {{ID: "shared"}},
	}
	tests := []struct {
		name     string
		audience string
		viewer   string
		target   string
		accepted bool
		servers  map[string][]models.ServerListItem
		count    int
		want     bool
	}{
		{name: "self is always visible", audience: "friends_only", viewer: "target", target: "target", want: true},
		{name: "accepted friend is always visible", audience: "friends_only", viewer: "viewer", target: "target", accepted: true, want: true},
		{name: "friends only denies non-friend", audience: "friends_only", viewer: "viewer", target: "target", servers: shared, count: 20},
		{name: "all shared servers allows", audience: "all_servers", viewer: "viewer", target: "target", servers: shared, count: 500, want: true},
		{name: "small shared server allows", audience: "small_servers", viewer: "viewer", target: "target", servers: shared, count: 200, want: true},
		{name: "large shared server denies", audience: "small_servers", viewer: "viewer", target: "target", servers: shared, count: 201},
		{name: "no shared server denies", audience: "all_servers", viewer: "viewer", target: "target", servers: map[string][]models.ServerListItem{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := NewProfileAudiencePolicy(
				profilePrefsStub{audience: tt.audience},
				profileFriendsStub{accepted: tt.accepted},
				profileServersStub{byUser: tt.servers, counts: map[string]int{"shared": tt.count}},
			)
			got, err := policy.CanView(context.Background(), tt.viewer, tt.target)
			if err != nil {
				t.Fatalf("CanView returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("CanView = %v, want %v", got, tt.want)
			}
		})
	}
}
