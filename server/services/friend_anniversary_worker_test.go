package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type anniversaryRepoStub struct {
	candidates []repository.FriendAnniversaryCandidate
	delivered  map[string]bool
	dueErr     error
	deliverErr error
	called     []string
}

func (r *anniversaryRepoStub) DueCandidates(_ context.Context, day string, leap bool, after string, limit int) ([]repository.FriendAnniversaryCandidate, error) {
	if r.dueErr != nil {
		return nil, r.dueErr
	}
	items := make([]repository.FriendAnniversaryCandidate, 0, limit)
	for _, candidate := range r.candidates {
		if candidate.FriendshipID > after && (candidate.AnniversaryDay == day || (leap && candidate.AnniversaryDay == "02-29")) {
			items = append(items, candidate)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].FriendshipID < items[j].FriendshipID })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (r *anniversaryRepoStub) Deliver(_ context.Context, friendship string, year int, recipient string, _ time.Time) (*models.Notification, error) {
	key := fmt.Sprintf("%s/%d/%s", friendship, year, recipient)
	r.called = append(r.called, key)
	if r.deliverErr != nil {
		return nil, r.deliverErr
	}
	if r.delivered[key] {
		return nil, nil
	}
	r.delivered[key] = true
	actor := "ann-b"
	if recipient == "ann-b" {
		actor = "ann-a"
	}
	return &models.Notification{ID: key, UserID: recipient, Kind: models.NotificationKindSystem, ActorID: &actor}, nil
}

type anniversaryHubSpy struct {
	users  []string
	events []ws.Event
}

func (h *anniversaryHubSpy) BroadcastToUser(user string, event ws.Event) {
	h.users = append(h.users, user)
	h.events = append(h.events, event)
}
func (*anniversaryHubSpy) BroadcastToAll(ws.Event)                          {}
func (*anniversaryHubSpy) BroadcastToAllExcept(string, ws.Event)            {}
func (*anniversaryHubSpy) BroadcastToUsers([]string, ws.Event)              {}
func (*anniversaryHubSpy) BroadcastToServer(string, ws.Event)               {}
func (*anniversaryHubSpy) BroadcastToServerExcept(string, string, ws.Event) {}

func TestFriendAnniversaryWorkerDeliversBothRecipientsAndDoesNotDuplicate(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &anniversaryRepoStub{
		candidates: []repository.FriendAnniversaryCandidate{{FriendshipID: "ann-f", UserID: "ann-a", FriendID: "ann-b", AcceptedAt: time.Date(2020, 10, 24, 12, 0, 0, 0, time.UTC), AnniversaryDay: "10-24"}},
		delivered:  map[string]bool{},
	}
	hub := &anniversaryHubSpy{}
	worker := NewFriendAnniversaryWorker(repo, hub)
	worker.now = func() time.Time { return now }
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.called) != 2 || len(hub.users) != 2 || hub.users[0] != "ann-a" || hub.users[1] != "ann-b" {
		t.Fatalf("delivery/broadcasts = %v / %v", repo.called, hub.users)
	}
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.called) != 4 || len(hub.users) != 2 {
		t.Fatalf("repeated tick recreated notifications: calls=%v broadcasts=%v", repo.called, hub.users)
	}
}

func TestFriendAnniversaryWorkerRetriesFailedCandidateAndUsesLeapObservation(t *testing.T) {
	now := time.Date(2025, 2, 28, 12, 0, 0, 0, time.UTC)
	repo := &anniversaryRepoStub{candidates: []repository.FriendAnniversaryCandidate{{FriendshipID: "leap", UserID: "ann-a", FriendID: "ann-b", AcceptedAt: time.Date(2020, 2, 29, 12, 0, 0, 0, time.UTC), AnniversaryDay: "02-29"}}, delivered: map[string]bool{}, deliverErr: errors.New("temporary")}
	worker := NewFriendAnniversaryWorker(repo, nil)
	hub := &anniversaryHubSpy{}
	worker.hub = hub
	worker.now = func() time.Time { return now }
	if err := worker.Tick(context.Background()); err == nil {
		t.Fatal("expected delivery error")
	}
	if worker.cursor != "" {
		t.Fatalf("failed candidate advanced cursor to %q", worker.cursor)
	}
	repo.deliverErr = nil
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.called) != 3 {
		t.Fatalf("retry should attempt both recipients after first failure, got %v", repo.called)
	}
	if len(hub.users) != 2 {
		t.Fatalf("successful retry broadcasts=%v, want one per recipient", hub.users)
	}
	if len(repo.candidates) == 0 {
		t.Fatal("test fixture unexpectedly empty")
	}
}

func TestFriendAnniversaryWorkerResetsCursorWhenUTCAnniversaryDayChanges(t *testing.T) {
	oldNow := time.Date(2026, 1, 1, 23, 59, 0, 0, time.UTC)
	items := make([]repository.FriendAnniversaryCandidate, friendAnniversaryPageLimit)
	for i := range items {
		items[i] = repository.FriendAnniversaryCandidate{
			FriendshipID: fmt.Sprintf("b%03d", i), UserID: "ann-a", FriendID: "ann-b",
			AcceptedAt: oldNow.AddDate(-2, 0, 0), AnniversaryDay: "01-01",
		}
	}
	repo := &anniversaryRepoStub{candidates: items, delivered: map[string]bool{}}
	worker := NewFriendAnniversaryWorker(repo, &anniversaryHubSpy{})
	current := oldNow
	worker.now = func() time.Time { return current }
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if worker.cursor != "b099" {
		t.Fatalf("full page cursor = %q, want b099", worker.cursor)
	}
	current = time.Date(2026, 1, 2, 0, 1, 0, 0, time.UTC)
	repo.candidates = []repository.FriendAnniversaryCandidate{{
		FriendshipID: "a000", UserID: "ann-a", FriendID: "ann-b",
		AcceptedAt: time.Date(2020, 1, 2, 8, 0, 0, 0, time.UTC), AnniversaryDay: "01-02",
	}}
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.called) != 202 || worker.cursor != "" {
		t.Fatalf("new UTC day was skipped or cursor wasn't wrapped: calls=%d cursor=%q", len(repo.called), worker.cursor)
	}
}
