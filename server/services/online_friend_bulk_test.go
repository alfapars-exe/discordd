package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type bulkOnlineNotices struct {
	*guardedOnlineNoticeRepo
	candidates []repository.OnlineFriendCandidate
	bulkCalls  int
}

func (r *bulkOnlineNotices) ListOnlineFriendCandidates(context.Context, string) ([]repository.OnlineFriendCandidate, error) {
	r.bulkCalls++
	return r.candidates, nil
}

func TestOnlineFriendBulkPrefilterAvoidsPerRecipientReadsAndStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	userReads := 0
	users := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
		userReads++
		return &models.User{ID: "actor", Username: "actor", Status: models.UserStatusOnline}, nil
	}}
	created := 0
	r := &bulkOnlineNotices{guardedOnlineNoticeRepo: guardedOnlineNotices(func(context.Context, *models.Notification) error { created++; cancel(); return nil })}
	for _, id := range []string{"one", "two", "three"} {
		r.candidates = append(r.candidates, repository.OnlineFriendCandidate{UserID: id, Preferences: &models.UserPreferences{UserID: id, Data: json.RawMessage(`{"notifications":{"onlineFriendNotifications":true}}`)}})
	}
	friends := &testutil.MockFriendshipRepo{IsBlockedFn: func(context.Context, string, string) (bool, error) {
		t.Fatal("per-recipient block read on bulk path")
		return false, nil
	}, ListFriendsFn: func(context.Context, string) ([]models.FriendshipWithUser, error) {
		t.Fatal("duplicate friends read on bulk path")
		return nil, nil
	}}
	n := NewOnlineFriendNotifier(users, onlineFriendPrefsStub{}, friends, r, onlineFriendPresenceStub{"actor"}, &testutil.MockEventPublisher{}).(*onlineFriendNotifier)
	defer n.Stop()
	err := n.NotifyOnline(ctx, "actor")
	if !errors.Is(err, context.Canceled) || created != 1 || userReads != 1 || r.bulkCalls != 1 {
		t.Fatalf("err=%v created=%d userReads=%d bulk=%d", err, created, userReads, r.bulkCalls)
	}
}

func TestOnlineFriendFreshBudgetAndShutdownCancellation(t *testing.T) {
	reads := 0
	users := &testutil.MockUserRepo{GetByIDFn: func(ctx context.Context, _ string) (*models.User, error) {
		reads++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) < 4*time.Second || time.Until(deadline) > 5*time.Second {
			t.Fatal("missing fresh 5s budget")
		}
		return nil, nil
	}}
	n := NewOnlineFriendNotifier(users, onlineFriendPrefsStub{}, &testutil.MockFriendshipRepo{}, guardedOnlineNotices(nil), onlineFriendPresenceStub{"actor"}, &testutil.MockEventPublisher{}).(*onlineFriendNotifier)
	if err := n.NotifyOnlinePresence("actor"); err != nil {
		t.Fatal(err)
	}
	n.Stop()
	if err := n.NotifyOnlinePresence("actor"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	if reads != 1 {
		t.Fatal("repository called after shutdown cancellation")
	}
}
