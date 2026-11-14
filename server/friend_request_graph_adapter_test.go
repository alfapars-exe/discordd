package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

func TestFriendRequestGraphAdapterPreservesContextAndFriendOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := &testutil.MockFriendshipRepo{ListFriendsFn: func(got context.Context, user string) ([]models.FriendshipWithUser, error) {
		if got != ctx || user != "target" {
			t.Fatal("friend list context or owner changed")
		}
		return []models.FriendshipWithUser{{UserID: "z"}, {UserID: "a"}}, nil
	}}
	ids, err := (friendRequestGraphAdapter{reader}).listFriendIDs(ctx, "target")
	if err != nil || !reflect.DeepEqual(ids, []string{"z", "a"}) {
		t.Fatalf("friend IDs: %v, %v", ids, err)
	}
	failure := errors.New("repository list failure")
	reader.ListFriendsFn = func(context.Context, string) ([]models.FriendshipWithUser, error) { return nil, failure }
	if ids, err := (friendRequestGraphAdapter{reader}).listFriendIDs(ctx, "target"); ids != nil || !errors.Is(err, failure) {
		t.Fatalf("list failure swallowed: %v, %v", ids, err)
	}
	reader.ListFriendsFn = nil
	if ids, err := (friendRequestGraphAdapter{reader}).listFriendIDs(ctx, "target"); err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("empty list contract: %v, %v", ids, err)
	}
}
func TestFriendRequestGraphAdapterUsesOnlyAcceptedEdgesAndPropagatesFailures(t *testing.T) {
	failure := errors.New("repository pair failure")
	for _, tc := range []struct {
		name   string
		status models.FriendshipStatus
		err    error
		want   bool
	}{
		{"accepted", models.FriendshipStatusAccepted, nil, true},
		{"pending", models.FriendshipStatusPending, nil, false},
		{"blocked", models.FriendshipStatusBlocked, nil, false},
		{"absent", "", fmt.Errorf("lookup: %w", pkg.ErrNotFound), false},
		{"failed", "", failure, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			reader := &testutil.MockFriendshipRepo{GetByPairFn: func(got context.Context, a, b string) (*models.Friendship, error) {
				if got != ctx || a != "sender" || b != "candidate" {
					t.Fatal("pair context or users changed")
				}
				return &models.Friendship{Status: tc.status}, tc.err
			}}
			accepted, err := (friendRequestGraphAdapter{reader}).AreFriends(ctx, "sender", "candidate")
			existingService := services.NewFriendshipService(nil, reader, nil, nil, nil, nil, nil)
			existingAccepted, existingErr := existingService.AreFriends(ctx, "sender", "candidate")
			if accepted != existingAccepted || !errors.Is(err, existingErr) {
				t.Fatalf("adapter differs from friendship service: %t/%v versus %t/%v", accepted, err, existingAccepted, existingErr)
			}
			if accepted != tc.want {
				t.Fatalf("accepted=%t want=%t", accepted, tc.want)
			}
			if tc.name == "failed" {
				if !errors.Is(err, failure) {
					t.Fatalf("pair error swallowed: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
