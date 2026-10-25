package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

type eventWorkerRepoStub struct {
	events             []models.ServerEvent
	users              map[string][]string
	delivered          map[string]bool
	dueErr             error
	pageErr            error
	deliverErrFor      map[string]error
	dueCalls           int
	pageCalls          int
	deliverCalls       int
	lastEventCursor    string
	lastRecipientAfter string
	lastEventLimit     int
	lastUserLimit      int
	now                time.Time
}

func (r *eventWorkerRepoStub) DueCandidates(_ context.Context, now time.Time, limit int, after string) ([]models.ServerEvent, error) {
	r.dueCalls++
	r.lastEventCursor, r.lastEventLimit = after, limit
	if r.dueErr != nil {
		return nil, r.dueErr
	}
	items := make([]models.ServerEvent, 0, limit)
	for _, event := range r.events {
		start, err := time.Parse(time.RFC3339Nano, event.StartsAt)
		if err == nil && event.ID > after && event.Status == models.ServerEventStatusScheduled && start.After(now) && start.Before(now.Add(24*time.Hour)) {
			items = append(items, event)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (r *eventWorkerRepoStub) InterestedPage(_ context.Context, eventID, after string, limit int) ([]string, error) {
	r.pageCalls++
	r.lastRecipientAfter, r.lastUserLimit = after, limit
	if r.pageErr != nil {
		return nil, r.pageErr
	}
	users := r.users[eventID]
	items := make([]string, 0, limit)
	for _, userID := range users {
		if userID > after && !r.delivered[eventID+"/"+userID] {
			items = append(items, userID)
		}
	}
	sort.Strings(items)
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (r *eventWorkerRepoStub) Deliver(_ context.Context, eventID string, version int64, userID string, now time.Time) (*models.Notification, error) {
	r.deliverCalls++
	if err := r.deliverErrFor[userID]; err != nil {
		return nil, err
	}
	for _, event := range r.events {
		if event.ID != eventID || event.Version != version || event.Status != models.ServerEventStatusScheduled {
			continue
		}
		start, err := time.Parse(time.RFC3339Nano, event.StartsAt)
		if err != nil || !start.After(now) || start.After(now.Add(24*time.Hour)) {
			return nil, nil
		}
		r.delivered[eventID+"/"+userID] = true
		return &models.Notification{ID: "n-" + userID, UserID: userID, Kind: models.NotificationKindSystem}, nil
	}
	return nil, nil
}

type workerHubSpy struct{ users []string }

func (h *workerHubSpy) BroadcastToUser(userID string, _ ws.Event)        { h.users = append(h.users, userID) }
func (h *workerHubSpy) BroadcastToAll(ws.Event)                          {}
func (h *workerHubSpy) BroadcastToAllExcept(string, ws.Event)            {}
func (h *workerHubSpy) BroadcastToUsers([]string, ws.Event)              {}
func (h *workerHubSpy) BroadcastToServer(string, ws.Event)               {}
func (h *workerHubSpy) BroadcastToServerExcept(string, string, ws.Event) {}

func newEventWorkerTest(now time.Time, events []models.ServerEvent, users []string) (*ServerEventWorker, *eventWorkerRepoStub, *workerHubSpy) {
	repo := &eventWorkerRepoStub{
		events: events, users: make(map[string][]string), delivered: make(map[string]bool),
		deliverErrFor: make(map[string]error), now: now,
	}
	if len(events) > 0 {
		repo.users[events[0].ID] = users
	}
	hub := &workerHubSpy{}
	worker := NewServerEventWorker(repo, hub)
	worker.now = func() time.Time { return now }
	return worker, repo, hub
}

func workerTestEvent(id string, startsAt time.Time) models.ServerEvent {
	return models.ServerEvent{ID: id, Version: 1, Status: models.ServerEventStatusScheduled, StartsAt: startsAt.UTC().Format(time.RFC3339Nano)}
}

func TestServerEventWorkerDrainProcessesSeveralPagesWithinOneRun(t *testing.T) {
	now := time.Now().UTC()
	users := make([]string, 305)
	for i := range users {
		users[i] = fmt.Sprintf("user-%04d", i)
	}
	worker, repo, hub := newEventWorkerTest(now, []models.ServerEvent{workerTestEvent("event-a", now.Add(time.Minute))}, users)
	if err := worker.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repo.deliverCalls != len(users) || len(hub.users) != len(users) {
		t.Fatalf("drain delivered=%d broadcasts=%d want %d", repo.deliverCalls, len(hub.users), len(users))
	}
	if repo.pageCalls > serverEventWorkerDrainPages {
		t.Fatalf("drain exceeded page budget: %d", repo.pageCalls)
	}
}

func TestServerEventWorkerPagesRecipientsAcrossTicksWithoutStarvation(t *testing.T) {
	now := time.Now().UTC()
	users := make([]string, 105)
	for i := range users {
		users[i] = fmt.Sprintf("user-%03d", i)
	}
	event := workerTestEvent("event-a", now.Add(10*time.Minute))
	worker, repo, hub := newEventWorkerTest(now, []models.ServerEvent{event}, users)
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repo.deliverCalls != serverEventWorkerUserPageLimit || repo.lastUserLimit != serverEventWorkerUserPageLimit || repo.lastRecipientAfter != "" {
		t.Fatalf("first bounded page: delivered=%d limit=%d after=%q", repo.deliverCalls, repo.lastUserLimit, repo.lastRecipientAfter)
	}
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repo.deliverCalls != len(users) || len(hub.users) != len(users) {
		t.Fatalf("two ticks delivered=%d broadcasts=%d, want %d", repo.deliverCalls, len(hub.users), len(users))
	}
	if repo.lastRecipientAfter != "user-099" {
		t.Fatalf("second page cursor = %q, want user-099", repo.lastRecipientAfter)
	}
	if worker.selectedEvent != nil || worker.eventCursor != "event-a" {
		t.Fatalf("completed event cursor state: selected=%+v cursor=%q", worker.selectedEvent, worker.eventCursor)
	}
}

func TestServerEventWorkerRefreshesSelectionAndBoundsDueCandidates(t *testing.T) {
	now := time.Now().UTC()
	event := workerTestEvent("event-a", now.Add(10*time.Minute))
	worker, repo, _ := newEventWorkerTest(now, []models.ServerEvent{event}, make([]string, 101))
	for i := range repo.users[event.ID] {
		repo.users[event.ID][i] = fmt.Sprintf("user-%03d", i)
	}
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo.events = nil // cancel or expire before the recipient page is complete
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repo.dueCalls != 2 || repo.lastEventLimit != serverEventWorkerEventPageLimit || repo.lastEventCursor != "" {
		t.Fatalf("selected event wasn't revalidated with bounded original page: calls=%d limit=%d cursor=%q", repo.dueCalls, repo.lastEventLimit, repo.lastEventCursor)
	}
	if worker.selectedEvent != nil || worker.eventCursor != event.ID {
		t.Fatalf("stale selection not advanced: selected=%+v cursor=%q", worker.selectedEvent, worker.eventCursor)
	}
}

func TestServerEventWorkerNoEventsAndRepositoryErrors(t *testing.T) {
	now := time.Now().UTC()
	worker, repo, hub := newEventWorkerTest(now, nil, nil)
	if err := worker.Tick(context.Background()); err != nil || worker.eventCursor != "" {
		t.Fatalf("empty tick cursor=%q err=%v", worker.eventCursor, err)
	}
	repo.dueErr = errors.New("candidate query failed")
	if err := worker.Tick(context.Background()); err == nil || err.Error() != "candidate query failed" {
		t.Fatalf("candidate error = %v", err)
	}
	if repo.deliverCalls != 0 || len(hub.users) != 0 {
		t.Fatal("candidate failure should not deliver or broadcast")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := worker.Tick(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled tick error = %v", err)
	}
}

func TestServerEventWorkerRetriesFailedRecipientAfterOtherUsers(t *testing.T) {
	now := time.Now().UTC()
	event := workerTestEvent("event-a", now.Add(10*time.Minute))
	worker, repo, hub := newEventWorkerTest(now, []models.ServerEvent{event}, []string{"a-failed", "b-ok"})
	repo.deliverErrFor["a-failed"] = errors.New("transient database error")
	if err := worker.Tick(context.Background()); err == nil {
		t.Fatal("delivery error should be visible to the worker loop")
	}
	if len(hub.users) != 1 || hub.users[0] != "b-ok" {
		t.Fatalf("healthy recipient blocked by failed recipient: broadcasts=%v", hub.users)
	}
	delete(repo.deliverErrFor, "a-failed")
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := worker.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(hub.users) != 2 || hub.users[1] != "a-failed" {
		t.Fatalf("failed recipient not retried after cursor wrap: broadcasts=%v", hub.users)
	}
}

func TestServerEventWorkerStartStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	worker, _, _ := newEventWorkerTest(time.Now().UTC(), nil, nil)
	stop := worker.Start(ctx)
	cancel()
	stop()
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cancel != nil {
		t.Fatal("worker cancellation lifecycle didn't reset")
	}
}
