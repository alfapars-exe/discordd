package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

// H-05: search results and TotalCount must both be scoped to the channels
// the caller may actually read (PermCanReadChannel — View AND Read,
// models/role.go:51). These tests wire a REAL channelPermService (production
// RBAC resolution, same convention channel_permission_service_test.go uses)
// behind a mocked SearchRepository, so the assertion is "the service handed
// the repository the right allow-list", not "a mock said what we told it to
// say".

const (
	searchUserID   = "user-1"
	searchServerID = "srv-1"
	searchChanA    = "chan-a"
	searchChanB    = "chan-b"
)

func newTestSearchService(
	searchRepo *testutil.MockSearchRepo,
	channelRepo *testutil.MockChannelRepo,
	roleRepo *testutil.MockRoleRepo,
	permRepo *testutil.MockChannelPermRepo,
) SearchService {
	permService := NewChannelPermissionService(permRepo, roleRepo, channelRepo, &testutil.MockBroadcaster{})
	return NewSearchService(searchRepo, channelRepo, permService)
}

// readableRole grants base View+Read; per-test overrides restrict individual
// channels from there.
func readableRole() []models.Role {
	return []models.Role{{ID: "r1", Permissions: models.PermViewChannel | models.PermReadMessages}}
}

func TestSearch_ExcludesUnreadableChannel(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return readableRole(), nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
			// chan-b: deny ReadMessages -> loses PermCanReadChannel there
			// even though the base role can view+read every channel.
			return []models.ChannelPermissionOverride{
				{ChannelID: searchChanB, RoleID: "r1", Deny: models.PermReadMessages},
			}, nil
		},
	}
	channelRepo := &testutil.MockChannelRepo{
		GetAllByServerFn: func(_ context.Context, _ string) ([]models.Channel, error) {
			return []models.Channel{{ID: searchChanA, ServerID: searchServerID}, {ID: searchChanB, ServerID: searchServerID}}, nil
		},
	}

	var callCount int
	var gotAllowed []string
	searchRepo := &testutil.MockSearchRepo{
		SearchFn: func(_ context.Context, _, _ string, _ *string, allowedChannelIDs []string, _, _ int) (*repository.SearchResult, error) {
			callCount++
			gotAllowed = allowedChannelIDs
			return &repository.SearchResult{
				Messages:   []models.Message{{ID: "m1", ChannelID: searchChanA}},
				TotalCount: 1,
			}, nil
		},
	}

	svc := newTestSearchService(searchRepo, channelRepo, roleRepo, permRepo)
	result, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", nil, 25, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if callCount != 1 {
		t.Fatalf("expected the repository to be called once, got %d", callCount)
	}
	if len(gotAllowed) != 1 || gotAllowed[0] != searchChanA {
		t.Fatalf("allowedChannelIDs = %v, want [%s]", gotAllowed, searchChanA)
	}
	// TotalCount is whatever the (correctly filtered) repository returned —
	// pins that the count-producing query, not just the page, receives the
	// filter (H-05's explicit "count must not be vacuous" concern).
	if result.TotalCount != 1 {
		t.Fatalf("TotalCount = %d, want 1", result.TotalCount)
	}
}

func TestSearch_ExplicitChannelIDUnreadable_ReturnsEmptyWithoutDBCall(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return readableRole(), nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByRolesFn: func(_ context.Context, _ []string) ([]models.ChannelPermissionOverride, error) {
			return []models.ChannelPermissionOverride{
				{ChannelID: searchChanB, RoleID: "r1", Deny: models.PermReadMessages},
			}, nil
		},
	}
	channelRepo := &testutil.MockChannelRepo{}

	var callCount int
	searchRepo := &testutil.MockSearchRepo{
		SearchFn: func(_ context.Context, _, _ string, _ *string, _ []string, _, _ int) (*repository.SearchResult, error) {
			callCount++
			return &repository.SearchResult{}, nil
		},
	}

	svc := newTestSearchService(searchRepo, channelRepo, roleRepo, permRepo)
	b := searchChanB
	result, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", &b, 25, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if callCount != 0 {
		t.Fatalf("repository must not be queried for an unreadable channel_id, got %d calls", callCount)
	}
	if result.TotalCount != 0 || len(result.Messages) != 0 {
		t.Fatalf("expected empty result, got %+v", result)
	}
}

func TestSearch_ExplicitChannelIDReadable_ReachesRepository(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return readableRole(), nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	channelRepo := &testutil.MockChannelRepo{}

	var gotChannelID *string
	var gotAllowed []string
	searchRepo := &testutil.MockSearchRepo{
		SearchFn: func(_ context.Context, _, _ string, channelID *string, allowedChannelIDs []string, _, _ int) (*repository.SearchResult, error) {
			gotChannelID = channelID
			gotAllowed = allowedChannelIDs
			return &repository.SearchResult{Messages: []models.Message{{ID: "m1"}}, TotalCount: 1}, nil
		},
	}

	svc := newTestSearchService(searchRepo, channelRepo, roleRepo, permRepo)
	a := searchChanA
	result, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", &a, 25, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotChannelID == nil || *gotChannelID != searchChanA {
		t.Fatalf("channelID passed to repo = %v, want %s", gotChannelID, searchChanA)
	}
	if len(gotAllowed) != 1 || gotAllowed[0] != searchChanA {
		t.Fatalf("allowedChannelIDs = %v, want [%s]", gotAllowed, searchChanA)
	}
	if result.TotalCount != 1 {
		t.Fatalf("TotalCount = %d, want 1", result.TotalCount)
	}
}

func TestSearch_Admin_NoChannelFilter(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return []models.Role{{ID: "r-admin", Permissions: models.PermAdmin}}, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	var listCalled bool
	channelRepo := &testutil.MockChannelRepo{
		GetAllByServerFn: func(_ context.Context, _ string) ([]models.Channel, error) {
			listCalled = true
			return []models.Channel{{ID: searchChanA}, {ID: searchChanB}}, nil
		},
	}

	var gotAllowed []string
	var repoCalled bool
	searchRepo := &testutil.MockSearchRepo{
		SearchFn: func(_ context.Context, _, _ string, _ *string, allowedChannelIDs []string, _, _ int) (*repository.SearchResult, error) {
			gotAllowed = allowedChannelIDs
			repoCalled = true
			return &repository.SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
		},
	}

	svc := newTestSearchService(searchRepo, channelRepo, roleRepo, permRepo)
	if _, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", nil, 25, 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !repoCalled {
		t.Fatal("repository was never called")
	}
	if gotAllowed != nil {
		t.Fatalf("admin caller must reach the repository unrestricted (nil allowedChannelIDs), got %v", gotAllowed)
	}
	if listCalled {
		t.Error("admin path must not enumerate the server's channels — IsAdmin short-circuits before any channel listing")
	}
}

func TestSearch_ValidatesQuery(t *testing.T) {
	svc := newTestSearchService(
		&testutil.MockSearchRepo{}, &testutil.MockChannelRepo{}, &testutil.MockRoleRepo{}, &testutil.MockChannelPermRepo{},
	)

	if _, err := svc.Search(context.Background(), searchServerID, searchUserID, "   ", nil, 25, 0); err == nil {
		t.Error("expected error for an empty/whitespace-only query")
	}

	long := make([]byte, 101)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := svc.Search(context.Background(), searchServerID, searchUserID, string(long), nil, 25, 0); err == nil {
		t.Error("expected error for an over-long query")
	}
}

func TestSearch_PermissionResolutionError(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return nil, errors.New("db error")
		},
	}
	svc := newTestSearchService(
		&testutil.MockSearchRepo{}, &testutil.MockChannelRepo{}, roleRepo, &testutil.MockChannelPermRepo{},
	)

	if _, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", nil, 25, 0); err == nil {
		t.Fatal("expected error when permission resolution fails")
	}
}

func TestSearch_NoReadableChannels_ReturnsEmptyWithoutDBCall(t *testing.T) {
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			// No ViewChannel/ReadMessages at all, no overrides granting either.
			return []models.Role{{ID: "r1", Permissions: models.PermSendMessages}}, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{}
	channelRepo := &testutil.MockChannelRepo{
		GetAllByServerFn: func(_ context.Context, _ string) ([]models.Channel, error) {
			return []models.Channel{{ID: searchChanA}, {ID: searchChanB}}, nil
		},
	}
	var callCount int
	searchRepo := &testutil.MockSearchRepo{
		SearchFn: func(_ context.Context, _, _ string, _ *string, _ []string, _, _ int) (*repository.SearchResult, error) {
			callCount++
			return &repository.SearchResult{}, nil
		},
	}

	svc := newTestSearchService(searchRepo, channelRepo, roleRepo, permRepo)
	result, err := svc.Search(context.Background(), searchServerID, searchUserID, "hello", nil, 25, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if callCount != 0 {
		t.Fatalf("repository must not be queried when the caller can read zero channels, got %d calls", callCount)
	}
	if result.TotalCount != 0 || len(result.Messages) != 0 {
		t.Fatalf("expected empty result, got %+v", result)
	}
}
