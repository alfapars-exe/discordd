package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// ─── FriendshipRepository mock ───

// MockFriendshipRepo satisfies repository.FriendshipRepository. Every method
// is nil-safe: with no Fn set, lookups report pkg.ErrNotFound (the sentinel
// the friendship/block services branch on via errors.Is), lists return nil
// and writes succeed.
type MockFriendshipRepo struct {
	CreateFn       func(ctx context.Context, friendship *models.Friendship) error
	GetByIDFn      func(ctx context.Context, id string) (*models.Friendship, error)
	GetByPairFn    func(ctx context.Context, userID, friendID string) (*models.Friendship, error)
	ListFriendsFn  func(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	ListIncomingFn func(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	ListOutgoingFn func(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	UpdateStatusFn func(ctx context.Context, id string, status models.FriendshipStatus) error
	DeleteFn       func(ctx context.Context, id string) error
	DeleteByPairFn func(ctx context.Context, userID, friendID string) error
	ListBlockedFn  func(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	IsBlockedFn    func(ctx context.Context, userA, userB string) (bool, error)
}

var _ repository.FriendshipRepository = (*MockFriendshipRepo)(nil)

func (m *MockFriendshipRepo) Create(ctx context.Context, friendship *models.Friendship) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, friendship)
	}
	return nil
}
func (m *MockFriendshipRepo) GetByID(ctx context.Context, id string) (*models.Friendship, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, pkg.ErrNotFound
}
func (m *MockFriendshipRepo) GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error) {
	if m.GetByPairFn != nil {
		return m.GetByPairFn(ctx, userID, friendID)
	}
	return nil, pkg.ErrNotFound
}
func (m *MockFriendshipRepo) ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	if m.ListFriendsFn != nil {
		return m.ListFriendsFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockFriendshipRepo) ListIncoming(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	if m.ListIncomingFn != nil {
		return m.ListIncomingFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockFriendshipRepo) ListOutgoing(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	if m.ListOutgoingFn != nil {
		return m.ListOutgoingFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockFriendshipRepo) UpdateStatus(ctx context.Context, id string, status models.FriendshipStatus) error {
	if m.UpdateStatusFn != nil {
		return m.UpdateStatusFn(ctx, id, status)
	}
	return nil
}
func (m *MockFriendshipRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockFriendshipRepo) DeleteByPair(ctx context.Context, userID, friendID string) error {
	if m.DeleteByPairFn != nil {
		return m.DeleteByPairFn(ctx, userID, friendID)
	}
	return nil
}
func (m *MockFriendshipRepo) ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	if m.ListBlockedFn != nil {
		return m.ListBlockedFn(ctx, userID)
	}
	return nil, nil
}
func (m *MockFriendshipRepo) IsBlocked(ctx context.Context, userA, userB string) (bool, error) {
	if m.IsBlockedFn != nil {
		return m.IsBlockedFn(ctx, userA, userB)
	}
	return false, nil
}
