package main

import (
	"context"
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type friendRequestGraphReader interface {
	ListFriends(context.Context, string) ([]models.FriendshipWithUser, error)
	GetByPair(context.Context, string, string) (*models.Friendship, error)
}

type friendRequestGraphAdapter struct{ reader friendRequestGraphReader }

func (a friendRequestGraphAdapter) listFriendIDs(ctx context.Context, userID string) ([]string, error) {
	friends, err := a.reader.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(friends))
	for _, friend := range friends {
		ids = append(ids, friend.UserID)
	}
	return ids, nil
}
func (a friendRequestGraphAdapter) areFriends(ctx context.Context, userA, userB string) (bool, error) {
	friendship, err := a.reader.GetByPair(ctx, userA, userB)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return friendship.Status == models.FriendshipStatusAccepted, nil
}
