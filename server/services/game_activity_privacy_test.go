package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type gameActivityPrefsStub struct {
	data []byte
	err  error
}

func (s gameActivityPrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	if s.err != nil {
		return nil, s.err
	}
	return &models.UserPreferences{Data: s.data}, nil
}

type gameActivityFriendsStub struct {
	accepted bool
	blocked  bool
	getErr   error
	blockErr error
}

func (s gameActivityFriendsStub) GetByPair(context.Context, string, string) (*models.Friendship, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	if !s.accepted {
		return nil, fmt.Errorf("no friendship: %w", pkg.ErrNotFound)
	}
	return &models.Friendship{Status: models.FriendshipStatusAccepted}, nil
}

func (s gameActivityFriendsStub) IsBlocked(context.Context, string, string) (bool, error) {
	return s.blocked, s.blockErr
}

type gameActivityServersStub struct {
	members     map[string]map[string]bool
	counts      map[string]int
	snapshots   map[string]bool
	memberErr   error
	countErr    error
	snapshotErr error
}

func (s gameActivityServersStub) GetMemberGameActivityAudience(_ context.Context, serverID, userID string) (*bool, error) {
	if s.snapshotErr != nil {
		return nil, s.snapshotErr
	}
	if !s.members[serverID][userID] {
		return nil, nil
	}
	allowed, ok := s.snapshots[serverID]
	if !ok {
		return nil, nil
	}
	return &allowed, nil
}

func (s gameActivityServersStub) IsMember(_ context.Context, serverID, userID string) (bool, error) {
	return s.members[serverID][userID], s.memberErr
}

func (s gameActivityServersStub) GetMemberCount(_ context.Context, serverID string) (int, error) {
	return s.counts[serverID], s.countErr
}

type gameActivityPresenceStub struct {
	visible bool
	err     error
}

func (s gameActivityPresenceStub) IsVisibleOnline(context.Context, string) (bool, error) {
	return s.visible, s.err
}

func gameActivityPolicy(data string, friends gameActivityFriendsStub, servers gameActivityServersStub, presence gameActivityPresenceStub, prefsErr error) GameActivityPrivacyPolicy {
	return NewGameActivityPrivacyPolicy(
		gameActivityPrefsStub{data: []byte(data), err: prefsErr},
		friends,
		servers,
		presence,
	)
}

func TestGameActivityPrivacyPolicyAudienceAndDefaults(t *testing.T) {
	members := gameActivityServersStub{
		members: map[string]map[string]bool{"shared": {"viewer": true, "target": true}, "large": {"viewer": true, "target": true}, "viewer-only": {"viewer": true}},
		counts:  map[string]int{"shared": 200, "large": 201},
	}
	visible := gameActivityPresenceStub{visible: true}
	tests := []struct {
		name     string
		data     string
		viewer   string
		target   string
		serverID string
		friends  gameActivityFriendsStub
		servers  gameActivityServersStub
		presence gameActivityPresenceStub
		want     bool
	}{
		{name: "self is always visible even offline and opted out", viewer: "target", target: "target", presence: gameActivityPresenceStub{}, want: true},
		{name: "sharing defaults off", data: `{"privacy":{"gameActivityNewServerAudience":"all"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: visible},
		{name: "accepted friend sees globally when opted in", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none"}}`, viewer: "viewer", target: "target", friends: gameActivityFriendsStub{accepted: true}, presence: visible, want: true},
		{name: "friend global grant does not bypass server snapshot opt-out", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none"}}`, viewer: "viewer", target: "target", serverID: "shared", friends: gameActivityFriendsStub{accepted: true}, servers: gameActivityServersStub{members: members.members, snapshots: map[string]bool{"shared": false}}, presence: visible},
		{name: "server override false beats accepted friendship", data: `{"privacy":{"shareGameActivity":true,"gameActivityServerOverrides":{"shared":false}}}`, viewer: "viewer", target: "target", serverID: "shared", friends: gameActivityFriendsStub{accepted: true}, servers: members, presence: visible},
		{name: "join-time snapshot allows shared member", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: gameActivityServersStub{members: members.members, counts: members.counts, snapshots: map[string]bool{"shared": true}}, presence: visible, want: true},
		{name: "join-time snapshot remains allowed despite changed default", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: gameActivityServersStub{members: members.members, snapshots: map[string]bool{"shared": true}}, presence: visible, want: true},
		{name: "legacy or absent snapshot denies despite all default", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: visible},
		{name: "small audience decision is frozen at join time", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"small"}}`, viewer: "viewer", target: "target", serverID: "large", servers: gameActivityServersStub{members: members.members, snapshots: map[string]bool{"large": false}}, presence: visible},
		{name: "none audience denies join snapshot", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: gameActivityServersStub{members: members.members, snapshots: map[string]bool{"shared": false}}, presence: visible},
		{name: "server override true enables that server", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"none","gameActivityServerOverrides":{"shared":true}}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: visible, want: true},
		{name: "server override false denies that server", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all","gameActivityServerOverrides":{"shared":false}}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: visible},
		{name: "server override cannot bypass global opt in", data: `{"privacy":{"gameActivityServerOverrides":{"shared":true}}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: visible},
		{name: "global audience is friends only", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all"}}`, viewer: "viewer", target: "target", friends: gameActivityFriendsStub{}, presence: visible},
		{name: "server audience requires viewer and target membership", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all"}}`, viewer: "viewer", target: "target", serverID: "viewer-only", servers: members, presence: visible},
		{name: "server-scoped friend still requires membership", data: `{"privacy":{"shareGameActivity":true}}`, viewer: "viewer", target: "target", serverID: "viewer-only", friends: gameActivityFriendsStub{accepted: true}, servers: members, presence: visible},
		{name: "offline target is hidden", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all"}}`, viewer: "viewer", target: "target", serverID: "shared", servers: members, presence: gameActivityPresenceStub{}},
		{name: "invisible target is hidden", data: `{"privacy":{"shareGameActivity":true}}`, viewer: "viewer", target: "target", friends: gameActivityFriendsStub{accepted: true}, presence: gameActivityPresenceStub{}},
		{name: "two-way block denies accepted friend", data: `{"privacy":{"shareGameActivity":true}}`, viewer: "viewer", target: "target", friends: gameActivityFriendsStub{accepted: true, blocked: true}, presence: visible},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.servers.members == nil && tt.servers.counts == nil {
				tt.servers = members
			}
			if tt.presence.err == nil && !tt.presence.visible && tt.name != "offline target is hidden" && tt.name != "invisible target is hidden" && tt.name != "self is always visible even offline and opted out" {
				tt.presence = visible
			}
			policy := gameActivityPolicy(tt.data, tt.friends, tt.servers, tt.presence, nil)
			got, err := policy.CanView(context.Background(), tt.viewer, tt.target, tt.serverID)
			if err != nil {
				t.Fatalf("CanView returned error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("CanView = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGameActivityPrivacyPolicyFailsClosed(t *testing.T) {
	boom := errors.New("reader unavailable")
	tests := []struct {
		name     string
		data     string
		friends  gameActivityFriendsStub
		servers  gameActivityServersStub
		presence gameActivityPresenceStub
		prefsErr error
		serverID string
	}{
		{name: "preference read", data: `{"privacy":{"shareGameActivity":true}}`, prefsErr: boom},
		{name: "presence read", data: `{"privacy":{"shareGameActivity":true}}`, presence: gameActivityPresenceStub{visible: true, err: boom}},
		{name: "block lookup", data: `{"privacy":{"shareGameActivity":true}}`, friends: gameActivityFriendsStub{blockErr: boom}, presence: gameActivityPresenceStub{visible: true}},
		{name: "friendship lookup", data: `{"privacy":{"shareGameActivity":true}}`, friends: gameActivityFriendsStub{getErr: boom}, presence: gameActivityPresenceStub{visible: true}},
		{name: "membership lookup", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"all"}}`, servers: gameActivityServersStub{memberErr: boom}, presence: gameActivityPresenceStub{visible: true}, serverID: "shared"},
		{name: "membership audience snapshot lookup", data: `{"privacy":{"shareGameActivity":true}}`, servers: gameActivityServersStub{members: map[string]map[string]bool{"shared": {"viewer": true, "target": true}}, snapshotErr: boom}, presence: gameActivityPresenceStub{visible: true}, serverID: "shared"},
		{name: "malformed preferences", data: `{"privacy":`, presence: gameActivityPresenceStub{visible: true}},
		{name: "invalid stored audience", data: `{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"friends"}}`, presence: gameActivityPresenceStub{visible: true}},
		{name: "oversized stored overrides", data: `{"privacy":{"shareGameActivity":true,"gameActivityServerOverrides":{}}}`, presence: gameActivityPresenceStub{visible: true}},
	}
	// Build a legacy stored map above the validated write limit to ensure the
	// read policy itself also fails closed for corrupted or migrated data.
	var largeOverrides = make(map[string]bool, gameActivityServerOverrideLimit+1)
	for i := 0; i <= gameActivityServerOverrideLimit; i++ {
		largeOverrides[fmt.Sprintf("server-%d", i)] = true
	}
	tests[len(tests)-1].data = fmt.Sprintf(`{"privacy":{"shareGameActivity":true,"gameActivityServerOverrides":%s}}`, mustJSON(t, largeOverrides))

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			servers := tt.servers
			if servers.members == nil {
				servers.members = map[string]map[string]bool{"shared": {"viewer": true, "target": true}}
			}
			if servers.counts == nil {
				servers.counts = map[string]int{"shared": 100}
			}
			presence := tt.presence
			if !presence.visible && presence.err == nil {
				presence.visible = true
			}
			policy := gameActivityPolicy(tt.data, tt.friends, servers, presence, tt.prefsErr)
			got, err := policy.CanView(context.Background(), "viewer", "target", tt.serverID)
			if err == nil {
				t.Fatalf("CanView = (%v, nil), want denial with error", got)
			}
			if got {
				t.Fatal("CanView allowed activity after a policy dependency or data failure")
			}
		})
	}
}

func TestGameActivityPrivacyPolicyRequiresIDsAndReaders(t *testing.T) {
	policy := NewGameActivityPrivacyPolicy(nil, nil, nil, nil)
	for _, ids := range [][2]string{{"", "target"}, {"viewer", ""}, {"viewer", "target"}} {
		got, err := policy.CanView(context.Background(), ids[0], ids[1], "")
		if err == nil || got {
			t.Fatalf("CanView(%q, %q) = (%v, %v), want fail-closed error", ids[0], ids[1], got, err)
		}
	}
	if got, err := policy.CanView(context.Background(), "self", "self", ""); err != nil || !got {
		t.Fatalf("self CanView = (%v, %v), want (true, nil)", got, err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
