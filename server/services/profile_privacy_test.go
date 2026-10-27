package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type profilePrefsStub struct{ audience string }

type profileAudienceInvalidatorStub struct {
	viewers []string
	err     error
}

func (s profileAudienceInvalidatorStub) ListProfileAudienceViewers(context.Context, string, ...string) ([]string, error) {
	return s.viewers, s.err
}

func (s profilePrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	return &models.UserPreferences{Data: []byte(fmt.Sprintf(`{"privacy":{"profileAudience":%q}}`, s.audience))}, nil
}
func (s profilePrefsStub) GetManyStrict(_ context.Context, ids []string) (map[string]*models.UserPreferences, error) {
	out := make(map[string]*models.UserPreferences, len(ids))
	for _, id := range ids {
		prefs, _ := s.Get(context.Background(), id)
		out[id] = prefs
	}
	return out, nil
}

type profileFriendsStub struct {
	accepted bool
	blocked  map[string]bool
	friendID string
}

func (s profileFriendsStub) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	if !s.accepted {
		return nil, fmt.Errorf("%w: no relationship", pkg.ErrNotFound)
	}
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}
func (s profileFriendsStub) ListFriends(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	if !s.accepted {
		return nil, nil
	}
	friendID := s.friendID
	if friendID == "" {
		friendID = "target"
	}
	return []models.FriendshipWithUser{{UserID: friendID, Status: models.FriendshipStatusAccepted}}, nil
}
func (s profileFriendsStub) IsBlocked(_ context.Context, a, b string) (bool, error) {
	return s.blocked[a] || s.blocked[b], nil
}
func (s profileFriendsStub) ListBlockedUserIDs(_ context.Context, _ string, ids []string) (map[string]bool, error) {
	out := make(map[string]bool)
	for _, id := range ids {
		if s.blocked[id] {
			out[id] = true
		}
	}
	return out, nil
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
func (s profileServersStub) IsMember(_ context.Context, serverID, userID string) (bool, error) {
	for _, server := range s.byUser[userID] {
		if server.ID == serverID {
			return true, nil
		}
	}
	return false, nil
}
func (s profileServersStub) ListMemberIDs(_ context.Context, serverID string) ([]string, error) {
	var ids []string
	for userID, servers := range s.byUser {
		for _, server := range servers {
			if server.ID == serverID {
				ids = append(ids, userID)
				break
			}
		}
	}
	return ids, nil
}
func (s profileServersStub) ListSmallSharedServerUserIDs(_ context.Context, viewerID string, targetIDs []string, maxMembers int) (map[string]bool, error) {
	viewerServers := make(map[string]struct{})
	for _, server := range s.byUser[viewerID] {
		if s.counts[server.ID] <= maxMembers {
			viewerServers[server.ID] = struct{}{}
		}
	}
	result := make(map[string]bool, len(targetIDs))
	for _, targetID := range targetIDs {
		for _, server := range s.byUser[targetID] {
			if _, ok := viewerServers[server.ID]; ok {
				result[targetID] = true
				break
			}
		}
	}
	return result, nil
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

type profileRawPrefsStub struct{ prefs *models.UserPreferences }

func (s profileRawPrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	return s.prefs, nil
}
func (s profileRawPrefsStub) GetManyStrict(_ context.Context, ids []string) (map[string]*models.UserPreferences, error) {
	out := make(map[string]*models.UserPreferences, len(ids))
	for _, id := range ids {
		out[id] = s.prefs
	}
	return out, nil
}

type profileNilFriendStub struct{}

func (profileNilFriendStub) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	return nil, nil
}
func (profileNilFriendStub) ListFriends(context.Context, string) ([]models.FriendshipWithUser, error) {
	return nil, nil
}
func (profileNilFriendStub) IsBlocked(context.Context, string, string) (bool, error) {
	return false, nil
}

func TestProfileAudienceRejectsInvalidPreferences(t *testing.T) {
	shared := profileServersStub{byUser: map[string][]models.ServerListItem{
		"viewer": {{ID: "shared"}}, "target": {{ID: "shared"}},
	}}
	for _, tt := range []struct {
		name  string
		prefs *models.UserPreferences
	}{
		{"missing", nil},
		{"null", &models.UserPreferences{Data: []byte(`null`)}},
		{"array", &models.UserPreferences{Data: []byte(`[]`)}},
		{"malformed", &models.UserPreferences{Data: []byte(`{`)}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			policy := NewProfileAudiencePolicy(profileRawPrefsStub{tt.prefs}, profileFriendsStub{}, shared)
			allowed, err := policy.CanView(context.Background(), "viewer", "target")
			if allowed || err == nil {
				t.Fatalf("invalid preferences allowed=%v err=%v", allowed, err)
			}
		})
	}
}

func TestProfileAudienceMissingInputsFailClosed(t *testing.T) {
	policy := NewProfileAudiencePolicy(nil, nil, nil)
	for _, ids := range [][2]string{{"", ""}, {"", "target"}, {"viewer", ""}, {"viewer", "target"}} {
		allowed, err := policy.CanView(context.Background(), ids[0], ids[1])
		if allowed || err == nil {
			t.Fatalf("IDs %q allowed=%v err=%v", ids, allowed, err)
		}
	}
	policy = NewProfileAudiencePolicy(profilePrefsStub{audience: "friends_only"}, profileNilFriendStub{}, profileServersStub{})
	allowed, err := policy.CanView(context.Background(), "viewer", "target")
	if allowed || err != nil {
		t.Fatalf("missing friendship allowed=%v err=%v", allowed, err)
	}
}

func TestProfileAudienceMemberRosterUsesSameServerFriendOwnerAndSizeRules(t *testing.T) {
	ctx := context.Background()
	servers := profileServersStub{
		byUser: map[string][]models.ServerListItem{
			"viewer": {{ID: "current"}, {ID: "tiny"}}, "friend": {{ID: "current"}},
			"all": {{ID: "current"}}, "small": {{ID: "current"}, {ID: "tiny"}},
			"private": {{ID: "current"}}, "blocked": {{ID: "current"}}, "other-server": {{ID: "elsewhere"}},
		},
		counts: map[string]int{"current": 201, "tiny": 2},
	}
	prefs := profileAudienceByIDStub{audiences: map[string]string{
		"all": "all_servers", "small": "small_servers", "private": "friends_only", "blocked": "all_servers",
	}}
	friends := profileFriendsByIDStub{ids: map[string]bool{"friend": true}, blocked: map[string]bool{"blocked": true}}
	policy := NewProfileAudiencePolicy(prefs, friends, servers)
	got, err := policy.CanViewInServerMany(ctx, "viewer", []string{"viewer", "friend", "all", "small", "private", "blocked", "other-server"}, "current")
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]bool{
		"viewer": true, "friend": true, "all": true, "small": true,
		"private": false, "blocked": false, "other-server": false,
	} {
		if got[id] != want {
			t.Errorf("CanViewInServerMany[%q]=%v, want %v", id, got[id], want)
		}
	}

	servers.counts["tiny"] = 201
	got, err = policy.CanViewInServerMany(ctx, "viewer", []string{"small"}, "current")
	if err != nil || got["small"] {
		t.Fatalf("large server: result=%v err=%v, want deny", got, err)
	}
	allowed, err := policy.CanViewInServer(ctx, "viewer", "other-server", "current")
	if err != nil || allowed {
		t.Fatalf("non-member target allowed=%v err=%v, want deny", allowed, err)
	}
}

type profileAudienceByIDStub struct{ audiences map[string]string }

func (s profileAudienceByIDStub) Get(_ context.Context, id string) (*models.UserPreferences, error) {
	audience := s.audiences[id]
	if audience == "" {
		audience = "all_servers"
	}
	return &models.UserPreferences{Data: []byte(fmt.Sprintf(`{"privacy":{"profileAudience":%q}}`, audience))}, nil
}
func (s profileAudienceByIDStub) GetManyStrict(ctx context.Context, ids []string) (map[string]*models.UserPreferences, error) {
	out := make(map[string]*models.UserPreferences, len(ids))
	for _, id := range ids {
		prefs, err := s.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		out[id] = prefs
	}
	return out, nil
}

type profileFriendsByIDStub struct {
	ids     map[string]bool
	blocked map[string]bool
}

func (s profileFriendsByIDStub) GetByPair(_ context.Context, _, targetID string) (*models.Friendship, error) {
	if s.ids[targetID] {
		return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
	}
	return nil, fmt.Errorf("%w: no relationship", pkg.ErrNotFound)
}
func (s profileFriendsByIDStub) ListFriends(_ context.Context, _ string) ([]models.FriendshipWithUser, error) {
	var out []models.FriendshipWithUser
	for id, accepted := range s.ids {
		if accepted {
			out = append(out, models.FriendshipWithUser{UserID: id, Status: models.FriendshipStatusAccepted})
		}
	}
	return out, nil
}
func (s profileFriendsByIDStub) IsBlocked(_ context.Context, a, b string) (bool, error) {
	return s.blocked[a] || s.blocked[b], nil
}
func (s profileFriendsByIDStub) ListBlockedUserIDs(_ context.Context, _ string, candidates []string) (map[string]bool, error) {
	result := map[string]bool{}
	for _, id := range candidates {
		if s.blocked[id] {
			result[id] = true
		}
	}
	return result, nil
}

func TestProfileAudienceInvalidationViewersAreScopedAndExcludeBlocks(t *testing.T) {
	prefs := profilePrefsStub{audience: "small_servers"}
	friends := profileFriendsStub{accepted: true, friendID: "blocked-friend", blocked: map[string]bool{"blocked-friend": true}}
	servers := profileServersStub{
		byUser: map[string][]models.ServerListItem{
			"target":       {{ID: "small"}, {ID: "large"}},
			"small-member": {{ID: "small"}},
			"large-member": {{ID: "large"}},
		},
		counts: map[string]int{"small": 2, "large": 201},
	}
	policy := NewProfileAudiencePolicy(prefs, friends, servers)
	viewers, err := policy.ListProfileAudienceViewers(context.Background(), "target", "friends_only", "small_servers")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, id := range viewers {
		got[id] = true
	}
	if !got["small-member"] || got["target"] {
		t.Fatalf("small-server member missing or target leaked: %v", viewers)
	}
	if got["large-member"] || got["blocked-friend"] || len(viewers) != 1 {
		t.Fatalf("invalidation escaped eligible scope: %v", viewers)
	}
}
