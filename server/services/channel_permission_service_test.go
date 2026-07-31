package services

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sort"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

// helper to create the service with mocks wired up.
func newTestChannelPermService(
	permRepo *testutil.MockChannelPermRepo,
	roleRepo *testutil.MockRoleRepo,
	channelRepo *testutil.MockChannelRepo,
	hub *testutil.MockBroadcaster,
) ChannelPermissionService {
	return NewChannelPermissionService(permRepo, roleRepo, channelRepo, hub)
}

// ─── ResolveChannelPermissions ───

func TestResolveChannelPermissions(t *testing.T) {
	const (
		userID    = "user-1"
		channelID = "chan-1"
		serverID  = "srv-1"
	)

	baseChannel := &models.Channel{ID: channelID, ServerID: serverID}

	tests := []struct {
		name      string
		roles     []models.Role
		overrides []models.ChannelPermissionOverride
		want      models.Permission
		wantErr   bool
	}{
		{
			name:  "should return 0 when user has no roles",
			roles: []models.Role{},
			want:  0,
		},
		{
			name: "should return base permissions when no overrides exist",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: nil,
			want:      models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should return PermAll when user has Admin role",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin | models.PermSendMessages},
			},
			want: models.PermAll,
		},
		{
			name: "should remove denied permission from base",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: 0, Deny: models.PermSendMessages},
			},
			want: models.PermReadMessages, // SendMessages stripped by deny
		},
		{
			name: "should add allowed permission not in base",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: models.PermSendMessages, Deny: 0},
			},
			want: models.PermReadMessages | models.PermSendMessages,
		},
		{
			name: "should let allow override deny for the same bit",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: models.PermSendMessages, Deny: models.PermSendMessages},
			},
			// (base & ^deny) | allow => removes SendMessages then adds it back
			want: models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should OR base permissions from multiple roles",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages},
				{ID: "r2", Permissions: models.PermReadMessages},
			},
			overrides: nil,
			want:      models.PermSendMessages | models.PermReadMessages,
		},
		{
			name: "should OR overrides across multiple roles",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages | models.PermConnectVoice},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Allow: 0, Deny: models.PermSendMessages},
				{ChannelID: channelID, RoleID: "r2", Allow: models.PermSpeak, Deny: models.PermConnectVoice},
			},
			// channelDeny = SendMessages | ConnectVoice
			// channelAllow = Speak
			// effective = ((Send|Read|Connect) & ^(Send|Connect)) | Speak = Read | Speak
			want: models.PermReadMessages | models.PermSpeak,
		},
		{
			name: "should bypass overrides completely for admin even with deny overrides",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin},
			},
			// overrides should not even be fetched for admin
			overrides: nil,
			want:      models.PermAll,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			permRepo := &testutil.MockChannelPermRepo{
				GetByChannelAndRolesFn: func(_ context.Context, _ string, _ []string) ([]models.ChannelPermissionOverride, error) {
					return tt.overrides, nil
				},
			}
			roleRepo := &testutil.MockRoleRepo{
				GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
					return tt.roles, nil
				},
			}
			channelRepo := &testutil.MockChannelRepo{
				GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
					return baseChannel, nil
				},
			}
			hub := &testutil.MockBroadcaster{}

			svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
			got, err := svc.ResolveChannelPermissions(context.Background(), userID, channelID)

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got permission %d, want %d", got, tt.want)
			}
		})
	}
}

func TestResolveChannelPermissions_ChannelNotFound(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return nil, errors.New("channel not found")
		},
	}
	roleRepo := &testutil.MockRoleRepo{}
	permRepo := &testutil.MockChannelPermRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.ResolveChannelPermissions(context.Background(), "u1", "bad-chan")
	if err == nil {
		t.Fatal("expected error when channel not found")
	}
}

func TestResolveChannelPermissions_RoleRepoError(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "c1", ServerID: "s1"}, nil
		},
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return nil, errors.New("db error")
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.ResolveChannelPermissions(context.Background(), "u1", "c1")
	if err == nil {
		t.Fatal("expected error when role repo fails")
	}
}

// ─── BuildVisibilityFilter ───

func TestBuildVisibilityFilter(t *testing.T) {
	const (
		userID   = "user-1"
		serverID = "srv-1"
	)

	tests := []struct {
		name            string
		roles           []models.Role
		overrides       []models.ChannelPermissionOverride
		wantAdmin       bool
		wantHasBaseView bool
		wantHidden      map[string]bool
		wantGranted     map[string]bool
	}{
		{
			name: "should return IsAdmin when user has Admin permission",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermAdmin},
			},
			wantAdmin: true,
		},
		{
			name: "should return empty maps when no overrides exist and user has ViewChannel",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides:       nil,
			wantHasBaseView: true,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should hide channel when base has ViewChannel but deny override removes it",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-secret", RoleID: "r1", Allow: 0, Deny: models.PermViewChannel},
			},
			wantHasBaseView: true,
			wantHidden:      map[string]bool{"chan-secret": true},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should grant channel when base lacks ViewChannel but allow override adds it",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages}, // no ViewChannel
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-special", RoleID: "r1", Allow: models.PermViewChannel, Deny: 0},
			},
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{"chan-special": true},
		},
		{
			name: "should handle multiple channels with mixed overrides",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermViewChannel | models.PermSendMessages},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-hidden", RoleID: "r1", Allow: 0, Deny: models.PermViewChannel},
				{ChannelID: "chan-visible", RoleID: "r1", Allow: models.PermSpeak, Deny: 0}, // no ViewChannel change
			},
			wantHasBaseView: true,
			wantHidden:      map[string]bool{"chan-hidden": true},
			wantGranted:     map[string]bool{}, // chan-visible still visible via base
		},
		{
			name:            "should return empty filter when user has no roles",
			roles:           []models.Role{},
			overrides:       nil,
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{},
		},
		{
			name: "should OR overrides across multiple roles for same channel",
			roles: []models.Role{
				{ID: "r1", Permissions: models.PermSendMessages}, // no ViewChannel
				{ID: "r2", Permissions: 0},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: "chan-1", RoleID: "r1", Allow: 0, Deny: 0},
				{ChannelID: "chan-1", RoleID: "r2", Allow: models.PermViewChannel, Deny: 0},
			},
			wantHasBaseView: false,
			wantHidden:      map[string]bool{},
			wantGranted:     map[string]bool{"chan-1": true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			roleRepo := &testutil.MockRoleRepo{
				GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
					return tt.roles, nil
				},
			}
			permRepo := &testutil.MockChannelPermRepo{
				GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
					return tt.overrides, nil
				},
			}
			channelRepo := &testutil.MockChannelRepo{}
			hub := &testutil.MockBroadcaster{}

			svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
			filter, err := svc.BuildVisibilityFilter(context.Background(), userID, serverID)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if filter.IsAdmin != tt.wantAdmin {
				t.Errorf("IsAdmin = %v, want %v", filter.IsAdmin, tt.wantAdmin)
			}

			// Admin filter has no further fields to check
			if tt.wantAdmin {
				return
			}

			if filter.HasBaseView != tt.wantHasBaseView {
				t.Errorf("HasBaseView = %v, want %v", filter.HasBaseView, tt.wantHasBaseView)
			}

			if len(filter.HiddenChannels) != len(tt.wantHidden) {
				t.Errorf("HiddenChannels length = %d, want %d", len(filter.HiddenChannels), len(tt.wantHidden))
			}
			for ch := range tt.wantHidden {
				if !filter.HiddenChannels[ch] {
					t.Errorf("expected channel %s to be hidden", ch)
				}
			}

			if len(filter.GrantedChannels) != len(tt.wantGranted) {
				t.Errorf("GrantedChannels length = %d, want %d", len(filter.GrantedChannels), len(tt.wantGranted))
			}
			for ch := range tt.wantGranted {
				if !filter.GrantedChannels[ch] {
					t.Errorf("expected channel %s to be granted", ch)
				}
			}
		})
	}
}

func TestBuildVisibilityFilter_RoleRepoError(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return nil, errors.New("db error")
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	channelRepo := &testutil.MockChannelRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.BuildVisibilityFilter(context.Background(), "u1", "s1")
	if err == nil {
		t.Fatal("expected error when role repo fails")
	}
}

func TestBuildVisibilityFilter_PermRepoError(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return []models.Role{{ID: "r1", Permissions: models.PermViewChannel}}, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
			return nil, errors.New("db error")
		},
	}
	channelRepo := &testutil.MockChannelRepo{}
	hub := &testutil.MockBroadcaster{}

	svc := newTestChannelPermService(permRepo, roleRepo, channelRepo, hub)
	_, err := svc.BuildVisibilityFilter(context.Background(), "u1", "s1")
	if err == nil {
		t.Fatal("expected error when perm repo fails")
	}
}

// ─── Cache invalidation ───
//
// These tests pin down the behaviour B1 wires up: when a role mutation
// or a member kick happens, the next ResolveChannelPermissions call MUST
// go back to the repo instead of returning a stale cached result. We
// detect "cache miss" by counting how many times the role repo's
// GetByUserIDAndServer fn fires — ResolveChannelPermissions calls it
// exactly once per cache miss.

// resolveCallCounter wires a role repo whose Get fn increments a
// counter, so a test can assert how many times Resolve actually touched
// the database.
type resolveCallCounter struct {
	count int
}

func (c *resolveCallCounter) roleRepo(roles []models.Role) *testutil.MockRoleRepo {
	return &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			c.count++
			return roles, nil
		},
	}
}

func newCachedSvc(roles []models.Role, counter *resolveCallCounter) ChannelPermissionService {
	permRepo := &testutil.MockChannelPermRepo{
		GetByChannelAndRolesFn: func(_ context.Context, _ string, _ []string) ([]models.ChannelPermissionOverride, error) {
			return nil, nil
		},
	}
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "c1", ServerID: "s1"}, nil
		},
	}
	return newTestChannelPermService(permRepo, counter.roleRepo(roles), channelRepo, &testutil.MockBroadcaster{})
}

func TestInvalidateUser_DropsThatUsersEntriesOnly(t *testing.T) {
	counter := &resolveCallCounter{}
	roles := []models.Role{{ID: "r1", Permissions: models.PermSendMessages}}
	svc := newCachedSvc(roles, counter)
	ctx := context.Background()

	// Warm cache for two users; expect 2 repo calls.
	_, _ = svc.ResolveChannelPermissions(ctx, "alice", "c1")
	_, _ = svc.ResolveChannelPermissions(ctx, "bob", "c1")
	if counter.count != 2 {
		t.Fatalf("cache warm-up: expected 2 repo hits, got %d", counter.count)
	}

	// Repeated lookups before invalidation are pure cache reads.
	_, _ = svc.ResolveChannelPermissions(ctx, "alice", "c1")
	_, _ = svc.ResolveChannelPermissions(ctx, "bob", "c1")
	if counter.count != 2 {
		t.Fatalf("cache hit: repo must not be touched (got %d total hits)", counter.count)
	}

	// Drop alice's entries — bob's must survive.
	svc.InvalidateUser("alice")

	_, _ = svc.ResolveChannelPermissions(ctx, "alice", "c1")
	if counter.count != 3 {
		t.Fatalf("post-invalidate alice: expected 3 repo hits, got %d", counter.count)
	}
	_, _ = svc.ResolveChannelPermissions(ctx, "bob", "c1")
	if counter.count != 3 {
		t.Fatalf("bob's cache must persist: expected 3 hits, got %d", counter.count)
	}
}

func TestInvalidateAll_DropsEveryEntry(t *testing.T) {
	counter := &resolveCallCounter{}
	roles := []models.Role{{ID: "r1", Permissions: models.PermSendMessages}}
	svc := newCachedSvc(roles, counter)
	ctx := context.Background()

	_, _ = svc.ResolveChannelPermissions(ctx, "alice", "c1")
	_, _ = svc.ResolveChannelPermissions(ctx, "bob", "c1")
	if counter.count != 2 {
		t.Fatalf("cache warm-up: expected 2 repo hits, got %d", counter.count)
	}

	svc.InvalidateAll()

	// Both users must miss after a full wipe.
	_, _ = svc.ResolveChannelPermissions(ctx, "alice", "c1")
	_, _ = svc.ResolveChannelPermissions(ctx, "bob", "c1")
	if counter.count != 4 {
		t.Fatalf("post-invalidate-all: expected 4 total hits, got %d", counter.count)
	}
}

// ─── ResolveChannelPermissionsBulk ───
//
// The bulk resolver exists to kill the fan-out N+1: broadcasting one message
// used to resolve permissions once per online member, and each cold-cache
// resolve costs 3 queries (channel + roles + overrides). These tests pin the
// query count *and* prove the answer is byte-identical to the single-user
// path, because a faster resolver that disagrees with the slow one is a
// security bug, not an optimisation.

// bulkRepoCounter counts every repository round trip the resolver makes, split
// by query, so a test can state the N+1 claim in concrete numbers.
type bulkRepoCounter struct {
	channelByID        int // channelGetter.GetByID          (both paths)
	rolesForUsers      int // roleRepo.GetRolesForUsers       (bulk only)
	overridesByChannel int // permRepo.GetByChannel           (bulk only)
	rolesByUser        int // roleRepo.GetByUserIDAndServer   (single only)
	overridesByRoles   int // permRepo.GetByChannelAndRoles   (single only)
}

func (c *bulkRepoCounter) total() int {
	return c.channelByID + c.rolesForUsers + c.overridesByChannel + c.rolesByUser + c.overridesByRoles
}

func (c *bulkRepoCounter) reset() { *c = bulkRepoCounter{} }

// permFixture is one channel's worth of RBAC state, served to either
// resolution path through counting mocks.
type permFixture struct {
	serverID  string
	channelID string
	roles     map[string][]models.Role // userID -> roles
	overrides []models.ChannelPermissionOverride
}

// newService wires the fixture into a real channelPermService (not a mock —
// the point is to exercise the production resolution code) with every repo
// call counted.
func (f permFixture) newService(c *bulkRepoCounter) ChannelPermissionService {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			c.channelByID++
			return &models.Channel{ID: f.channelID, ServerID: f.serverID}, nil
		},
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
			c.rolesByUser++
			return f.roles[userID], nil
		},
		GetRolesForUsersFn: func(_ context.Context, _ string, userIDs []string) (map[string][]models.Role, error) {
			c.rolesForUsers++
			out := make(map[string][]models.Role, len(userIDs))
			for _, uid := range userIDs {
				if rs := f.roles[uid]; len(rs) > 0 {
					out[uid] = rs
				}
			}
			return out, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByChannelFn: func(_ context.Context, _ string) ([]models.ChannelPermissionOverride, error) {
			c.overridesByChannel++
			return f.overrides, nil
		},
		GetByChannelAndRolesFn: func(_ context.Context, _ string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
			c.overridesByRoles++
			// Mirrors the real SQL: filter this channel's overrides to the
			// caller's role set.
			set := make(map[string]bool, len(roleIDs))
			for _, id := range roleIDs {
				set[id] = true
			}
			var out []models.ChannelPermissionOverride
			for _, o := range f.overrides {
				if set[o.RoleID] {
					out = append(out, o)
				}
			}
			return out, nil
		},
	}
	return newTestChannelPermService(permRepo, roleRepo, channelRepo, &testutil.MockBroadcaster{})
}

// TestResolveChannelPermissionsBulk_QueryCount is the headline regression
// guard: the same 100-member fan-out that costs 300 queries one user at a time
// must cost exactly 3 in bulk, regardless of member count.
func TestResolveChannelPermissionsBulk_QueryCount(t *testing.T) {
	const memberCount = 100

	fixture := permFixture{serverID: "srv-1", channelID: "chan-1", roles: map[string][]models.Role{}}
	users := make([]string, memberCount)
	for i := range users {
		users[i] = fmt.Sprintf("user-%d", i)
		fixture.roles[users[i]] = []models.Role{
			{ID: "r1", Permissions: models.PermViewChannel | models.PermReadMessages},
		}
	}

	// Baseline: the loop this change replaces.
	singleCounter := &bulkRepoCounter{}
	singleSvc := fixture.newService(singleCounter)
	for _, uid := range users {
		if _, err := singleSvc.ResolveChannelPermissions(context.Background(), uid, fixture.channelID); err != nil {
			t.Fatalf("single resolve: %v", err)
		}
	}
	if singleCounter.total() != 3*memberCount {
		t.Fatalf("single-user loop baseline: got %d queries, want %d (%+v)",
			singleCounter.total(), 3*memberCount, *singleCounter)
	}

	// Bulk: constant, and specifically one of each query.
	bulkCounter := &bulkRepoCounter{}
	bulkSvc := fixture.newService(bulkCounter)
	got, err := bulkSvc.ResolveChannelPermissionsBulk(context.Background(), fixture.channelID, users)
	if err != nil {
		t.Fatalf("bulk resolve: %v", err)
	}
	if len(got) != memberCount {
		t.Fatalf("bulk returned %d entries, want %d", len(got), memberCount)
	}
	if bulkCounter.total() > 3 {
		t.Errorf("bulk issued %d queries, want at most 3 (%+v)", bulkCounter.total(), *bulkCounter)
	}
	if bulkCounter.channelByID != 1 || bulkCounter.rolesForUsers != 1 || bulkCounter.overridesByChannel != 1 {
		t.Errorf("bulk query shape = %+v, want exactly one of each batched query", *bulkCounter)
	}
	if bulkCounter.rolesByUser != 0 || bulkCounter.overridesByRoles != 0 {
		t.Errorf("bulk must not fall back to the per-user queries: %+v", *bulkCounter)
	}
}

func TestResolveChannelPermissionsBulk_EmptyUserIDs(t *testing.T) {
	counter := &bulkRepoCounter{}
	svc := permFixture{serverID: "srv-1", channelID: "chan-1"}.newService(counter)

	for _, users := range [][]string{nil, {}} {
		got, err := svc.ResolveChannelPermissionsBulk(context.Background(), "chan-1", users)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("expected empty result, got %v", got)
		}
	}
	if counter.total() != 0 {
		t.Errorf("empty input must not touch the database, got %+v", *counter)
	}
}

func TestResolveChannelPermissionsBulk_MixedCacheHitsAndMisses(t *testing.T) {
	fixture := permFixture{
		serverID:  "srv-1",
		channelID: "chan-1",
		roles: map[string][]models.Role{
			"alice": {{ID: "r1", Permissions: models.PermReadMessages}},
			"bob":   {{ID: "r1", Permissions: models.PermReadMessages}},
			"carol": {{ID: "r1", Permissions: models.PermReadMessages}},
		},
	}
	counter := &bulkRepoCounter{}
	svc := fixture.newService(counter)
	ctx := context.Background()

	// Warm alice through the single-user path — the caches must be shared.
	if _, err := svc.ResolveChannelPermissions(ctx, "alice", "chan-1"); err != nil {
		t.Fatalf("warm alice: %v", err)
	}
	counter.reset()

	var askedFor []string
	svcImpl := svc.(*channelPermService)
	inner := svcImpl.roleRepo.(*testutil.MockRoleRepo)
	prev := inner.GetRolesForUsersFn
	inner.GetRolesForUsersFn = func(ctx context.Context, serverID string, userIDs []string) (map[string][]models.Role, error) {
		askedFor = append([]string(nil), userIDs...)
		return prev(ctx, serverID, userIDs)
	}

	got, err := svc.ResolveChannelPermissionsBulk(ctx, "chan-1", []string{"alice", "bob", "carol"})
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected all 3 users in the result, got %v", got)
	}
	if counter.total() > 3 {
		t.Errorf("bulk with a warm entry issued %d queries, want at most 3 (%+v)", counter.total(), *counter)
	}
	// The cached user must not be re-fetched.
	if len(askedFor) != 2 || askedFor[0] != "bob" || askedFor[1] != "carol" {
		t.Errorf("GetRolesForUsers asked for %v, want only the cache misses [bob carol]", askedFor)
	}
}

// TestResolveChannelPermissionsBulk_SharesCacheKeysWithSinglePath is the
// critical compatibility assertion: bulk must write the *same* cache keys the
// single path reads, so every existing invalidation hook keeps working without
// being taught about bulk.
func TestResolveChannelPermissionsBulk_SharesCacheKeysWithSinglePath(t *testing.T) {
	fixture := permFixture{
		serverID:  "srv-1",
		channelID: "chan-1",
		roles: map[string][]models.Role{
			"alice": {{ID: "r1", Permissions: models.PermReadMessages}},
			"bob":   {{ID: "r1", Permissions: models.PermReadMessages}},
		},
	}
	counter := &bulkRepoCounter{}
	svc := fixture.newService(counter)
	ctx := context.Background()

	if _, err := svc.ResolveChannelPermissionsBulk(ctx, "chan-1", []string{"alice", "bob"}); err != nil {
		t.Fatalf("bulk: %v", err)
	}
	counter.reset()

	// A single-user resolve must now be a pure cache read.
	if _, err := svc.ResolveChannelPermissions(ctx, "alice", "chan-1"); err != nil {
		t.Fatalf("single after bulk: %v", err)
	}
	if counter.total() != 0 {
		t.Errorf("single resolve after bulk should hit the cache, issued %+v", *counter)
	}

	// And the existing invalidation hooks must still reach bulk-written entries.
	svc.InvalidateUser("alice")
	if _, err := svc.ResolveChannelPermissions(ctx, "alice", "chan-1"); err != nil {
		t.Fatalf("single after invalidate: %v", err)
	}
	if counter.total() == 0 {
		t.Error("InvalidateUser did not drop the bulk-written cache entry")
	}

	// bob's entry survives, and a full wipe reaches it too.
	counter.reset()
	if _, err := svc.ResolveChannelPermissions(ctx, "bob", "chan-1"); err != nil {
		t.Fatalf("bob after alice invalidate: %v", err)
	}
	if counter.total() != 0 {
		t.Errorf("InvalidateUser(alice) must not drop bob's bulk-written entry, issued %+v", *counter)
	}
	svc.InvalidateAll()
	counter.reset()
	if _, err := svc.ResolveChannelPermissions(ctx, "bob", "chan-1"); err != nil {
		t.Fatalf("bob after InvalidateAll: %v", err)
	}
	if counter.total() == 0 {
		t.Error("InvalidateAll did not drop the bulk-written cache entry")
	}
}

func TestResolveChannelPermissionsBulk_Semantics(t *testing.T) {
	const channelID = "chan-1"

	tests := []struct {
		name      string
		roles     map[string][]models.Role
		overrides []models.ChannelPermissionOverride
		want      map[string]models.Permission
	}{
		{
			name:  "user with zero roles resolves to 0",
			roles: map[string][]models.Role{"u1": nil},
			want:  map[string]models.Permission{"u1": 0},
		},
		{
			name: "admin bypasses every override",
			roles: map[string][]models.Role{
				"admin": {{ID: "r-admin", Permissions: models.PermAdmin}},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r-admin", Deny: models.PermAll},
			},
			want: map[string]models.Permission{"admin": models.PermAll},
		},
		{
			name: "deny override strips a base bit for the affected user only",
			roles: map[string][]models.Role{
				"muted":  {{ID: "r-muted", Permissions: models.PermSendMessages | models.PermReadMessages}},
				"normal": {{ID: "r-normal", Permissions: models.PermSendMessages | models.PermReadMessages}},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r-muted", Deny: models.PermSendMessages},
			},
			want: map[string]models.Permission{
				"muted":  models.PermReadMessages,
				"normal": models.PermSendMessages | models.PermReadMessages,
			},
		},
		{
			name: "allow override grants a bit missing from base",
			roles: map[string][]models.Role{
				"guest": {{ID: "r-guest", Permissions: models.PermReadMessages}},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r-guest", Allow: models.PermSendMessages},
			},
			want: map[string]models.Permission{
				"guest": models.PermReadMessages | models.PermSendMessages,
			},
		},
		{
			name: "overrides OR across a user's roles and allow wins over deny",
			roles: map[string][]models.Role{
				"u1": {
					{ID: "r1", Permissions: models.PermSendMessages | models.PermReadMessages | models.PermConnectVoice},
					{ID: "r2", Permissions: 0},
				},
			},
			overrides: []models.ChannelPermissionOverride{
				{ChannelID: channelID, RoleID: "r1", Deny: models.PermSendMessages | models.PermConnectVoice},
				{ChannelID: channelID, RoleID: "r2", Allow: models.PermSendMessages},
				// Belongs to a role u1 does not hold — must be ignored.
				{ChannelID: channelID, RoleID: "r-other", Deny: models.PermReadMessages},
			},
			want: map[string]models.Permission{
				"u1": models.PermReadMessages | models.PermSendMessages,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := permFixture{
				serverID: "srv-1", channelID: channelID,
				roles: tt.roles, overrides: tt.overrides,
			}
			svc := fixture.newService(&bulkRepoCounter{})

			users := make([]string, 0, len(tt.want))
			for uid := range tt.want {
				users = append(users, uid)
			}
			sort.Strings(users)

			got, err := svc.ResolveChannelPermissionsBulk(context.Background(), channelID, users)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			for _, uid := range users {
				if got[uid] != tt.want[uid] {
					t.Errorf("user %s: got %d, want %d", uid, got[uid], tt.want[uid])
				}
			}
		})
	}
}

// TestResolveChannelPermissionsBulk_ParityWithSinglePath is the property test
// that stops the two resolution formulas from silently forking. For randomised
// role/override fixtures, bulk(users) must equal a loop of the single-user
// resolver over the same users — every time.
func TestResolveChannelPermissionsBulk_ParityWithSinglePath(t *testing.T) {
	rng := rand.New(rand.NewSource(20260719))

	for iteration := 0; iteration < 200; iteration++ {
		// Random role catalogue for the server.
		roleCount := 1 + rng.Intn(5)
		roleIDs := make([]string, roleCount)
		catalogue := make([]models.Role, roleCount)
		for i := range catalogue {
			roleIDs[i] = fmt.Sprintf("r%d", i)
			perms := models.Permission(rng.Int63n(int64(models.PermAll) + 1))
			if rng.Intn(10) == 0 { // ~10% of roles are admin
				perms |= models.PermAdmin
			}
			catalogue[i] = models.Role{ID: roleIDs[i], Permissions: perms}
		}

		// Random overrides — including ones for roles nobody holds, and
		// several rows for the same role so the OR path is exercised.
		var overrides []models.ChannelPermissionOverride
		for _, rid := range roleIDs {
			for n := rng.Intn(3); n > 0; n-- {
				overrides = append(overrides, models.ChannelPermissionOverride{
					ChannelID: "chan-1",
					RoleID:    rid,
					Allow:     models.Permission(rng.Int63n(int64(models.PermAll) + 1)),
					Deny:      models.Permission(rng.Int63n(int64(models.PermAll) + 1)),
				})
			}
		}
		if rng.Intn(2) == 0 {
			overrides = append(overrides, models.ChannelPermissionOverride{
				ChannelID: "chan-1", RoleID: "r-nobody", Deny: models.PermAll,
			})
		}

		// Random per-user role assignment; some users deliberately get none.
		userCount := 1 + rng.Intn(8)
		users := make([]string, userCount)
		rolesByUser := make(map[string][]models.Role, userCount)
		for i := range users {
			users[i] = fmt.Sprintf("u%d", i)
			var held []models.Role
			for _, role := range catalogue {
				if rng.Intn(2) == 0 {
					held = append(held, role)
				}
			}
			rolesByUser[users[i]] = held
		}

		fixture := permFixture{
			serverID: "srv-1", channelID: "chan-1",
			roles: rolesByUser, overrides: overrides,
		}

		// Separate service instances so neither path warms the other's cache.
		bulkSvc := fixture.newService(&bulkRepoCounter{})
		singleSvc := fixture.newService(&bulkRepoCounter{})

		bulk, err := bulkSvc.ResolveChannelPermissionsBulk(context.Background(), "chan-1", users)
		if err != nil {
			t.Fatalf("iteration %d: bulk: %v", iteration, err)
		}
		for _, uid := range users {
			want, err := singleSvc.ResolveChannelPermissions(context.Background(), uid, "chan-1")
			if err != nil {
				t.Fatalf("iteration %d: single %s: %v", iteration, uid, err)
			}
			if bulk[uid] != want {
				t.Fatalf("iteration %d: user %s: bulk=%d single=%d\nroles=%+v\noverrides=%+v",
					iteration, uid, bulk[uid], want, rolesByUser[uid], overrides)
			}
		}
	}
}

func TestResolveChannelPermissionsBulk_RepoErrors(t *testing.T) {
	boom := errors.New("db error")

	t.Run("channel lookup failure", func(t *testing.T) {
		svc := newTestChannelPermService(
			&testutil.MockChannelPermRepo{},
			&testutil.MockRoleRepo{},
			&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return nil, boom
			}},
			&testutil.MockBroadcaster{},
		)
		if _, err := svc.ResolveChannelPermissionsBulk(context.Background(), "c1", []string{"u1"}); err == nil {
			t.Fatal("expected error when the channel lookup fails")
		}
	})

	t.Run("role lookup failure", func(t *testing.T) {
		svc := newTestChannelPermService(
			&testutil.MockChannelPermRepo{},
			&testutil.MockRoleRepo{GetRolesForUsersFn: func(_ context.Context, _ string, _ []string) (map[string][]models.Role, error) {
				return nil, boom
			}},
			&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "c1", ServerID: "s1"}, nil
			}},
			&testutil.MockBroadcaster{},
		)
		if _, err := svc.ResolveChannelPermissionsBulk(context.Background(), "c1", []string{"u1"}); err == nil {
			t.Fatal("expected error when the bulk role lookup fails")
		}
	})

	t.Run("override lookup failure", func(t *testing.T) {
		svc := newTestChannelPermService(
			&testutil.MockChannelPermRepo{GetByChannelFn: func(_ context.Context, _ string) ([]models.ChannelPermissionOverride, error) {
				return nil, boom
			}},
			&testutil.MockRoleRepo{GetRolesForUsersFn: func(_ context.Context, _ string, _ []string) (map[string][]models.Role, error) {
				return map[string][]models.Role{"u1": {{ID: "r1"}}}, nil
			}},
			&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "c1", ServerID: "s1"}, nil
			}},
			&testutil.MockBroadcaster{},
		)
		if _, err := svc.ResolveChannelPermissionsBulk(context.Background(), "c1", []string{"u1"}); err == nil {
			t.Fatal("expected error when the override lookup fails")
		}
	})
}

// ─── N-03: SetOverride / DeleteOverride escalation + hierarchy guards ───
//
// Both are gated on the actor's own CHANNEL-scoped effective permission
// (ResolveChannelPermissions), not the server-wide role OR the route's
// authServerPerm(PermManageChannels) middleware already checked, and on the
// role-hierarchy rule RoleService applies to role edits (Position vs the
// actor's highest role position).

const (
	n03ServerID  = "srv-n03"
	n03ChannelID = "chan-n03"
	n03ActorID   = "actor-n03"
	n03TargetID  = "role-target"
)

// n03Fixture wires a channel, a target role and an actor whose own role has
// the given Position/Permissions — everything checkChannelOverrideHierarchy
// and checkOverrideEscalation read.
type n03Fixture struct {
	actorPosition    int
	actorPermissions models.Permission
	targetPosition   int
	// actorChannelOverride optionally further restricts/extends the actor's
	// own channel-scoped permission, proving the escalation check reads the
	// CHANNEL-scoped resolution and not just the raw role bits.
	actorChannelOverride *models.ChannelPermissionOverride
}

func (f n03Fixture) build(setCalled *bool, deleteCalled *bool) ChannelPermissionService {
	const actorRoleID = "role-actor"

	actorRole := models.Role{ID: actorRoleID, Position: f.actorPosition, Permissions: f.actorPermissions}
	targetRole := &models.Role{ID: n03TargetID, ServerID: n03ServerID, Position: f.targetPosition}

	permRepo := &testutil.MockChannelPermRepo{
		GetByChannelAndRolesFn: func(_ context.Context, _ string, _ []string) ([]models.ChannelPermissionOverride, error) {
			if f.actorChannelOverride != nil {
				return []models.ChannelPermissionOverride{*f.actorChannelOverride}, nil
			}
			return nil, nil
		},
		SetFn: func(_ context.Context, _ *models.ChannelPermissionOverride) error {
			if setCalled != nil {
				*setCalled = true
			}
			return nil
		},
		DeleteFn: func(_ context.Context, _, _ string) error {
			if deleteCalled != nil {
				*deleteCalled = true
			}
			return nil
		},
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
			if userID == n03ActorID {
				return []models.Role{actorRole}, nil
			}
			return nil, nil
		},
		GetByIDFn: func(_ context.Context, id string) (*models.Role, error) {
			if id == n03TargetID {
				return targetRole, nil
			}
			return nil, errors.New("unknown role")
		},
	}
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: n03ServerID}, nil
		},
	}

	return newTestChannelPermService(permRepo, roleRepo, channelRepo, &testutil.MockBroadcaster{})
}

func TestSetOverride_RejectsAllowBitActorDoesNotHold(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:    5,
		actorPermissions: models.PermManageChannels, // ManageChannels is not channel-overridable and grants nothing here
		targetPosition:   3,
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	req := &models.SetOverrideRequest{Allow: models.PermManageMessages}
	err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if setCalled {
		t.Error("permRepo.Set must not be called when the actor lacks the requested Allow bit")
	}
}

func TestSetOverride_RejectsDenyBitActorDoesNotHold(t *testing.T) {
	// KULLANICI KARARI: Deny is checked exactly like Allow — denying a bit
	// the actor doesn't hold can lock a higher-privileged role out of the
	// channel, the mirror image of granting escalated privilege.
	fixture := n03Fixture{
		actorPosition:    5,
		actorPermissions: models.PermManageChannels,
		targetPosition:   3,
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	req := &models.SetOverrideRequest{Deny: models.PermManageMessages}
	err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if setCalled {
		t.Error("permRepo.Set must not be called when the actor lacks the requested Deny bit")
	}
}

func TestSetOverride_AllowsBitActorHolds(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:    5,
		actorPermissions: models.PermManageChannels | models.PermManageMessages,
		targetPosition:   3,
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	req := &models.SetOverrideRequest{Allow: models.PermManageMessages}
	if err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !setCalled {
		t.Error("permRepo.Set must be called when the actor holds every requested bit")
	}
}

func TestSetOverride_RejectsEqualOrHigherTargetPosition(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:    5,
		actorPermissions: models.PermManageChannels | models.PermManageMessages,
		targetPosition:   5, // equal to actor's own position
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	req := &models.SetOverrideRequest{Allow: models.PermManageMessages}
	err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden for an equal-or-higher target role position, got %v", err)
	}
	if setCalled {
		t.Error("permRepo.Set must not be called when the hierarchy check fails")
	}
}

func TestSetOverride_AdminBypassesEscalationCheck(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:    10,
		actorPermissions: models.PermAdmin,
		targetPosition:   3,
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	// A bit the admin doesn't literally hold via a specific flag — PermAdmin
	// bypasses the check entirely (ResolveChannelPermissions resolves admin
	// to PermAll).
	req := &models.SetOverrideRequest{Allow: models.PermManageMessages, Deny: models.PermConnectVoice}
	if err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req); err != nil {
		t.Fatalf("admin actor must bypass the escalation check: %v", err)
	}
	if !setCalled {
		t.Error("permRepo.Set must be called for the admin bypass case")
	}
}

func TestSetOverride_ChannelScopedNotServerWide(t *testing.T) {
	// The actor's role grants ManageMessages server-wide, but this specific
	// channel has a Deny override stripping it back out — the escalation
	// check must use the CHANNEL-scoped resolution, not the raw role bits,
	// or an actor demoted on one channel could still re-grant the bit there.
	fixture := n03Fixture{
		actorPosition:    5,
		actorPermissions: models.PermManageChannels | models.PermManageMessages,
		targetPosition:   3,
		actorChannelOverride: &models.ChannelPermissionOverride{
			ChannelID: n03ChannelID, RoleID: "role-actor", Deny: models.PermManageMessages,
		},
	}
	var setCalled bool
	svc := fixture.build(&setCalled, nil)

	req := &models.SetOverrideRequest{Allow: models.PermManageMessages}
	err := svc.SetOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID, req)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden once the channel-scoped override strips the actor's bit, got %v", err)
	}
	if setCalled {
		t.Error("permRepo.Set must not be called once the channel override removes the actor's bit")
	}
}

func TestDeleteOverride_RejectsEqualOrHigherTargetPosition(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:  5,
		targetPosition: 5,
	}
	var deleteCalled bool
	svc := fixture.build(nil, &deleteCalled)

	err := svc.DeleteOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden for an equal-or-higher target role position, got %v", err)
	}
	if deleteCalled {
		t.Error("permRepo.Delete must not be called when the hierarchy check fails")
	}
}

func TestDeleteOverride_AllowsLowerPositionTarget(t *testing.T) {
	fixture := n03Fixture{
		actorPosition:  5,
		targetPosition: 3,
	}
	var deleteCalled bool
	svc := fixture.build(nil, &deleteCalled)

	if err := svc.DeleteOverride(context.Background(), n03ServerID, n03ChannelID, n03TargetID, n03ActorID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !deleteCalled {
		t.Error("permRepo.Delete must be called once the hierarchy check passes")
	}
}
