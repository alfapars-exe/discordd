package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type serverEventRepoStub struct {
	repository.ServerEventRepository
	events              map[string]models.ServerEvent
	createCalls         int
	getCalls            int
	listCalls           int
	listLimit           int
	listBefore          string
	updateCalls         int
	cancelCalls         int
	interestCalls       int
	interestUser        string
	interestEvent       string
	interestValue       bool
	interested          map[string]bool
	isInterestedCalls   int
	isInterestedErr     error
	createErr           error
	getErr              error
	listErr             error
	updateErr           error
	cancelErr           error
	setInterestedErr    error
	forceUpdateMismatch bool
	forceCancelMismatch bool
}

func newServerEventRepoStub() *serverEventRepoStub {
	return &serverEventRepoStub{events: make(map[string]models.ServerEvent), interested: make(map[string]bool)}
}

func eventKey(serverID, eventID string) string { return serverID + "/" + eventID }

func cloneServerEvent(event models.ServerEvent) *models.ServerEvent {
	copy := event
	if event.EndsAt != nil {
		value := *event.EndsAt
		copy.EndsAt = &value
	}
	if event.ChannelID != nil {
		value := *event.ChannelID
		copy.ChannelID = &value
	}
	return &copy
}

func (r *serverEventRepoStub) Create(_ context.Context, event *models.ServerEvent) error {
	r.createCalls++
	if r.createErr != nil {
		return r.createErr
	}
	if event.ID == "" {
		event.ID = "event-1"
	}
	if event.Version == 0 {
		event.Version = 1
	}
	event.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	event.UpdatedAt = event.CreatedAt
	r.events[eventKey(event.ServerID, event.ID)] = *cloneServerEvent(*event)
	return nil
}

func (r *serverEventRepoStub) GetByID(_ context.Context, serverID, eventID string) (*models.ServerEvent, error) {
	r.getCalls++
	if r.getErr != nil {
		return nil, r.getErr
	}
	event, ok := r.events[eventKey(serverID, eventID)]
	if !ok {
		return nil, pkg.ErrNotFound
	}
	return cloneServerEvent(event), nil
}

func (r *serverEventRepoStub) List(_ context.Context, serverID string, limit int, beforeID string) ([]models.ServerEvent, error) {
	r.listCalls++
	r.listLimit, r.listBefore = limit, beforeID
	if r.listErr != nil {
		return nil, r.listErr
	}
	out := make([]models.ServerEvent, 0)
	for _, event := range r.events {
		if event.ServerID == serverID {
			out = append(out, *cloneServerEvent(event))
		}
	}
	return out, nil
}

func (r *serverEventRepoStub) UpdateCAS(_ context.Context, event *models.ServerEvent, expected int64) (bool, error) {
	r.updateCalls++
	if r.updateErr != nil {
		return false, r.updateErr
	}
	if r.forceUpdateMismatch {
		return false, nil
	}
	key := eventKey(event.ServerID, event.ID)
	current, ok := r.events[key]
	if !ok || current.Version != expected || current.Status != models.ServerEventStatusScheduled {
		return false, nil
	}
	event.Version = expected + 1
	event.CreatedAt = current.CreatedAt
	event.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	r.events[key] = *cloneServerEvent(*event)
	return true, nil
}

func (r *serverEventRepoStub) CancelCAS(_ context.Context, serverID, eventID string, expected int64) (bool, error) {
	r.cancelCalls++
	if r.cancelErr != nil {
		return false, r.cancelErr
	}
	if r.forceCancelMismatch {
		return false, nil
	}
	key := eventKey(serverID, eventID)
	event, ok := r.events[key]
	if !ok || event.Version != expected || event.Status != models.ServerEventStatusScheduled {
		return false, nil
	}
	event.Status = models.ServerEventStatusCancelled
	event.Version++
	event.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	r.events[key] = event
	return true, nil
}

func (r *serverEventRepoStub) SetInterested(_ context.Context, eventID, userID string, interested bool) error {
	r.interestCalls++
	r.interestEvent, r.interestUser, r.interestValue = eventID, userID, interested
	if r.setInterestedErr != nil {
		return r.setInterestedErr
	}
	r.interested[eventID+"/"+userID] = interested
	return nil
}

func (r *serverEventRepoStub) IsInterested(_ context.Context, eventID, userID string) (bool, error) {
	r.isInterestedCalls++
	if r.isInterestedErr != nil {
		return false, r.isInterestedErr
	}
	return r.interested[eventID+"/"+userID], nil
}

type serverEventServerRepoStub struct {
	repository.ServerRepository
	member   bool
	calls    int
	serverID string
	userID   string
	err      error
}

func (s *serverEventServerRepoStub) IsMember(_ context.Context, serverID, userID string) (bool, error) {
	s.calls++
	s.serverID, s.userID = serverID, userID
	return s.member, s.err
}

type serverEventRoleRepoStub struct {
	repository.RoleRepository
	roles    []models.Role
	calls    int
	serverID string
	userID   string
	err      error
}

func (r *serverEventRoleRepoStub) GetByUserIDAndServer(_ context.Context, userID, serverID string) ([]models.Role, error) {
	r.calls++
	r.serverID, r.userID = serverID, userID
	return r.roles, r.err
}

type serverEventChannelRepoStub struct {
	repository.ChannelRepository
	channels map[string]*models.Channel
	calls    int
	err      error
}

func (r *serverEventChannelRepoStub) GetByID(_ context.Context, id string) (*models.Channel, error) {
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	channel, ok := r.channels[id]
	if !ok {
		return nil, pkg.ErrNotFound
	}
	return channel, nil
}

type serverEventPermStub struct {
	ChannelPermResolver
	permissions map[string]models.Permission
	calls       int
	err         error
	userID      string
	channelID   string
}

func (p *serverEventPermStub) ResolveChannelPermissions(_ context.Context, userID, channelID string) (models.Permission, error) {
	p.calls++
	p.userID, p.channelID = userID, channelID
	if p.err != nil {
		return 0, p.err
	}
	return p.permissions[channelID], nil
}

func (p *serverEventPermStub) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	return nil, errors.New("unused")
}

type serverEventFixture struct {
	service  ServerEventService
	repo     *serverEventRepoStub
	servers  *serverEventServerRepoStub
	roles    *serverEventRoleRepoStub
	channels *serverEventChannelRepoStub
	perms    *serverEventPermStub
}

func newServerEventFixture() *serverEventFixture {
	repo := newServerEventRepoStub()
	servers := &serverEventServerRepoStub{member: true}
	roles := &serverEventRoleRepoStub{roles: []models.Role{{ServerID: "server-a", Permissions: models.PermManageEvents}}}
	channels := &serverEventChannelRepoStub{channels: map[string]*models.Channel{
		"channel-a": {ID: "channel-a", ServerID: "server-a"},
		"channel-b": {ID: "channel-b", ServerID: "server-b"},
	}}
	perms := &serverEventPermStub{permissions: make(map[string]models.Permission)}
	return &serverEventFixture{
		service: NewServerEventService(repo, servers, roles, channels, perms),
		repo:    repo, servers: servers, roles: roles, channels: channels, perms: perms,
	}
}

func futureServerEventRequest() *models.CreateServerEventRequest {
	start := time.Now().UTC().Add(time.Hour)
	end := start.Add(time.Hour)
	endValue := end.Format(time.RFC3339Nano)
	channelID := "channel-a"
	return &models.CreateServerEventRequest{
		Name: "Community night", Description: "Play games together", StartsAt: start.Format(time.RFC3339Nano),
		EndsAt: &endValue, ChannelID: &channelID,
	}
}

func seedServerEvent(f *serverEventFixture, event models.ServerEvent) {
	if event.ID == "" {
		event.ID = "event-1"
	}
	if event.ServerID == "" {
		event.ServerID = "server-a"
	}
	if event.CreatorID == "" {
		event.CreatorID = "creator"
	}
	if event.Status == "" {
		event.Status = models.ServerEventStatusScheduled
	}
	if event.Version == 0 {
		event.Version = 1
	}
	if event.StartsAt == "" {
		event.StartsAt = time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	}
	f.repo.events[eventKey(event.ServerID, event.ID)] = event
}

func TestServerEventCreateRequiresServerManagerAndPersistsNormalizedEvent(t *testing.T) {
	f := newServerEventFixture()
	f.perms.permissions["channel-a"] = models.PermViewChannel | models.PermReadMessages
	req := futureServerEventRequest()
	event, err := f.service.Create(context.Background(), "server-a", "manager", req)
	if err != nil {
		t.Fatal(err)
	}
	if event.ServerID != "server-a" || event.CreatorID != "manager" || event.ID != "event-1" || event.Version != 1 || event.Status != models.ServerEventStatusScheduled {
		t.Fatalf("created event has wrong server/creator/state: %+v", event)
	}
	if event.ChannelID == nil || *event.ChannelID != "channel-a" {
		t.Fatalf("manager can read channel but response lost channel: %+v", event.ChannelID)
	}
	if event.Interested {
		t.Fatal("new event unexpectedly included an RSVP")
	}
	if f.servers.calls != 1 || f.roles.calls != 1 || f.roles.serverID != "server-a" || f.roles.userID != "manager" || f.repo.createCalls != 1 {
		t.Fatalf("unexpected authorization/write calls: members=%d roles=%d repoCreate=%d", f.servers.calls, f.roles.calls, f.repo.createCalls)
	}

	f = newServerEventFixture()
	f.roles.roles = []models.Role{{ServerID: "server-b", Permissions: models.PermManageEvents}}
	if _, err = f.service.Create(context.Background(), "server-a", "manager", futureServerEventRequest()); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("foreign-server role should not authorize event create, got %v", err)
	}
	if f.repo.createCalls != 0 {
		t.Fatal("foreign-server manager permission wrote an event")
	}
}

func TestServerEventMembershipIsRequiredForEveryOperation(t *testing.T) {
	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{ID: "event-1", ChannelID: nil})
	f.servers.member = false
	ctx := context.Background()
	operations := []struct {
		name string
		call func() error
	}{
		{"create", func() error {
			_, err := f.service.Create(ctx, "server-a", "member", futureServerEventRequest())
			return err
		}},
		{"list", func() error { _, err := f.service.List(ctx, "server-a", "member", 20, ""); return err }},
		{"get", func() error { _, err := f.service.Get(ctx, "server-a", "event-1", "member"); return err }},
		{"update", func() error {
			_, err := f.service.Update(ctx, "server-a", "event-1", "member", &models.UpdateServerEventRequest{ExpectedVersion: 1})
			return err
		}},
		{"cancel", func() error { _, err := f.service.Cancel(ctx, "server-a", "event-1", "member", 1); return err }},
		{"interest", func() error { return f.service.SetInterested(ctx, "server-a", "event-1", "member", true) }},
	}
	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			if err := operation.call(); !errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("nonmember operation error = %v, want forbidden", err)
			}
		})
	}
	if f.servers.calls != len(operations) || f.roles.calls != 0 || f.repo.createCalls+f.repo.listCalls+f.repo.getCalls+f.repo.updateCalls+f.repo.cancelCalls+f.repo.interestCalls != 0 {
		t.Fatalf("membership wasn't checked before repo/manager work: memberCalls=%d roleCalls=%d repoCalls=%d", f.servers.calls, f.roles.calls, f.repo.createCalls+f.repo.listCalls+f.repo.getCalls+f.repo.updateCalls+f.repo.cancelCalls+f.repo.interestCalls)
	}
}

func TestServerEventReadRedactsOnlyUnreadableOrForeignChannelID(t *testing.T) {
	f := newServerEventFixture()
	channelID := "channel-a"
	seedServerEvent(f, models.ServerEvent{ID: "hidden", Name: "Open event", Description: "All members can read this", ChannelID: &channelID})
	event, err := f.service.Get(context.Background(), "server-a", "hidden", "member")
	if err != nil {
		t.Fatal(err)
	}
	if event.ChannelID != nil || event.Name != "Open event" || event.Description != "All members can read this" {
		t.Fatalf("hidden channel should be redacted without hiding server-wide event fields: %+v", event)
	}

	f.perms.permissions[channelID] = models.PermViewChannel | models.PermReadMessages
	f.repo.interested["hidden/member"] = true
	event, err = f.service.Get(context.Background(), "server-a", "hidden", "member")
	if err != nil || event.ChannelID == nil || *event.ChannelID != channelID || !event.Interested {
		t.Fatalf("readable channel should remain visible: event=%+v err=%v", event, err)
	}

	foreignID := "channel-b"
	seedServerEvent(f, models.ServerEvent{ID: "corrupt", Name: "Still server-wide", Description: "No foreign channel details", ChannelID: &foreignID})
	f.perms.permissions[foreignID] = models.PermViewChannel | models.PermReadMessages | models.PermAdmin
	event, err = f.service.Get(context.Background(), "server-a", "corrupt", "member")
	if err != nil || event.ChannelID != nil || event.Name != "Still server-wide" {
		t.Fatalf("foreign channel association was not redacted: event=%+v err=%v", event, err)
	}

	f.perms.err = errors.New("permission resolver unavailable")
	event, err = f.service.Get(context.Background(), "server-a", "hidden", "member")
	if err != nil || event.ChannelID != nil {
		t.Fatalf("resolver failure must fail closed for channel disclosure: event=%+v err=%v", event, err)
	}
}

func TestServerEventCreateAndUpdateRejectForeignChannel(t *testing.T) {
	f := newServerEventFixture()
	request := futureServerEventRequest()
	foreignID := "channel-b"
	request.ChannelID = &foreignID
	if _, err := f.service.Create(context.Background(), "server-a", "manager", request); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("foreign channel create error = %v, want not found", err)
	}
	if f.repo.createCalls != 0 {
		t.Fatal("foreign channel event was persisted")
	}

	seedServerEvent(f, models.ServerEvent{ID: "event-1"})
	if _, err := f.service.Update(context.Background(), "server-a", "event-1", "manager", &models.UpdateServerEventRequest{
		Name: "Updated", Description: "", StartsAt: request.StartsAt, ChannelID: &foreignID, ExpectedVersion: 1,
	}); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("foreign channel update error = %v, want not found", err)
	}
	if f.repo.updateCalls != 0 {
		t.Fatal("foreign channel event update reached CAS")
	}
}

func TestServerEventCreateAndUpdateRequireReadableLinkedChannel(t *testing.T) {
	f := newServerEventFixture()
	if _, err := f.service.Create(context.Background(), "server-a", "manager", futureServerEventRequest()); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("unreadable channel create error = %v, want forbidden", err)
	}
	if f.repo.createCalls != 0 {
		t.Fatal("event linked to unreadable channel was persisted")
	}

	seedServerEvent(f, models.ServerEvent{ID: "event-1"})
	request := futureServerEventRequest()
	if _, err := f.service.Update(context.Background(), "server-a", "event-1", "manager", &models.UpdateServerEventRequest{
		Name: request.Name, Description: request.Description, StartsAt: request.StartsAt,
		EndsAt: request.EndsAt, ChannelID: request.ChannelID, ExpectedVersion: 1,
	}); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("unreadable channel update error = %v, want forbidden", err)
	}
	if f.repo.updateCalls != 0 {
		t.Fatal("update linked event to unreadable channel before permission check")
	}
}

func TestServerEventValidationBoundsAndCAS(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*models.CreateServerEventRequest)
	}{
		{"empty name", func(r *models.CreateServerEventRequest) { r.Name = "  " }},
		{"long name", func(r *models.CreateServerEventRequest) { r.Name = strings.Repeat("x", 101) }},
		{"long description codepoints", func(r *models.CreateServerEventRequest) { r.Description = strings.Repeat("🔥", 2001) }},
		{"past start", func(r *models.CreateServerEventRequest) {
			r.StartsAt = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
		}},
		{"more than one year ahead", func(r *models.CreateServerEventRequest) {
			r.StartsAt = time.Now().UTC().AddDate(1, 0, 0).Add(time.Second).Format(time.RFC3339Nano)
		}},
		{"invalid time", func(r *models.CreateServerEventRequest) { r.StartsAt = "tomorrow" }},
		{"end not after start", func(r *models.CreateServerEventRequest) { r.EndsAt = &r.StartsAt }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newServerEventFixture()
			request := futureServerEventRequest()
			test.mutate(request)
			if _, err := f.service.Create(context.Background(), "server-a", "manager", request); !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("invalid create error = %v, want bad request", err)
			}
			if f.repo.createCalls != 0 {
				t.Fatal("invalid event reached repository")
			}
		})
	}

	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{ID: "event-1"})
	if _, err := f.service.Update(context.Background(), "server-a", "event-1", "manager", &models.UpdateServerEventRequest{ExpectedVersion: 0}); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("zero update version error = %v, want bad request", err)
	}
	if _, err := f.service.Cancel(context.Background(), "server-a", "event-1", "manager", -1); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("negative cancel version error = %v, want bad request", err)
	}
}

func TestServerEventUpdateCancelAndInterestUseScopedCAS(t *testing.T) {
	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{ID: "event-1", Name: "Before", Description: "Original"})
	start := time.Now().UTC().Add(2 * time.Hour).Format(time.RFC3339Nano)
	updated, err := f.service.Update(context.Background(), "server-a", "event-1", "manager", &models.UpdateServerEventRequest{
		Name: "After", Description: "Updated description", StartsAt: start, ExpectedVersion: 1,
	})
	if err != nil || updated.Version != 2 || updated.Name != "After" {
		t.Fatalf("update result = %+v, err=%v", updated, err)
	}
	if _, err := f.service.Update(context.Background(), "server-a", "event-1", "manager", &models.UpdateServerEventRequest{
		Name: "Stale", StartsAt: start, ExpectedVersion: 1,
	}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale update error = %v, want conflict", err)
	}
	if err := f.service.SetInterested(context.Background(), "server-a", "event-1", "member", true); err != nil {
		t.Fatalf("positive RSVP to future scheduled event: %v", err)
	}
	cancelled, err := f.service.Cancel(context.Background(), "server-a", "event-1", "manager", 2)
	if err != nil || cancelled.Status != models.ServerEventStatusCancelled || cancelled.Version != 3 {
		t.Fatalf("cancel result = %+v, err=%v", cancelled, err)
	}
	if err := f.service.SetInterested(context.Background(), "server-a", "event-1", "member", true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("positive RSVP to cancelled event error = %v, want conflict", err)
	}
	if err := f.service.SetInterested(context.Background(), "server-a", "event-1", "member", false); err != nil {
		t.Fatalf("withdrawal from cancelled event should remain allowed: %v", err)
	}
	if f.repo.interestCalls != 2 || f.repo.interestEvent != "event-1" || f.repo.interestUser != "member" || f.repo.interestValue {
		t.Fatalf("interest write not scoped to caller/event: calls=%d event=%q user=%q interested=%v", f.repo.interestCalls, f.repo.interestEvent, f.repo.interestUser, f.repo.interestValue)
	}
	got, err := f.service.Get(context.Background(), "server-a", "event-1", "member")
	if err != nil || got.Interested {
		t.Fatalf("viewer RSVP state after withdrawal = %+v, %v; want false", got, err)
	}
	if _, err = f.service.Get(context.Background(), "server-b", "event-1", "member"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("event lookup must remain server-scoped, got %v", err)
	}
}

func TestServerEventPositiveInterestRejectsStartedEvent(t *testing.T) {
	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{
		ID: "started", StartsAt: time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
	})
	if err := f.service.SetInterested(context.Background(), "server-a", "started", "member", true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("positive RSVP to started event error = %v, want conflict", err)
	}
	if f.repo.interestCalls != 0 {
		t.Fatal("positive RSVP to started event reached repository")
	}
	if err := f.service.SetInterested(context.Background(), "server-a", "started", "member", false); err != nil {
		t.Fatalf("withdrawal from started event should remain allowed: %v", err)
	}
	if f.repo.interestCalls != 1 || f.repo.interestValue {
		t.Fatalf("started event withdrawal not persisted: calls=%d interested=%v", f.repo.interestCalls, f.repo.interestValue)
	}
}

func TestServerEventRoleRepositoryFailureAndMembershipFailureFailClosed(t *testing.T) {
	f := newServerEventFixture()
	f.roles.err = errors.New("role storage unavailable")
	if _, err := f.service.Create(context.Background(), "server-a", "manager", futureServerEventRequest()); err == nil || err.Error() != "role storage unavailable" {
		t.Fatalf("role lookup failure should propagate, got %v", err)
	}
	if f.repo.createCalls != 0 {
		t.Fatal("role lookup failure wrote event")
	}

	f = newServerEventFixture()
	f.servers.err = errors.New("membership storage unavailable")
	if _, err := f.service.List(context.Background(), "server-a", "member", 20, ""); err == nil || err.Error() != "membership storage unavailable" {
		t.Fatalf("membership lookup failure should propagate, got %v", err)
	}
	if f.repo.listCalls != 0 {
		t.Fatal("membership lookup failure read event repository")
	}
}

func TestServerEventListClampsLimitAndPassesCursor(t *testing.T) {
	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{ID: "event-1", ChannelID: nil})
	_, err := f.service.List(context.Background(), "server-a", "member", 1000, "event-1")
	if err != nil {
		t.Fatal(err)
	}
	if f.repo.listCalls != 1 || f.repo.listLimit != serverEventListDefaultLimit || f.repo.listBefore != "event-1" {
		t.Fatalf("list args calls=%d limit=%d before=%q", f.repo.listCalls, f.repo.listLimit, f.repo.listBefore)
	}
}

func TestServerEventRSVPReadFailureFailsClosedAndListIncludesViewerState(t *testing.T) {
	f := newServerEventFixture()
	seedServerEvent(f, models.ServerEvent{ID: "event-1", ChannelID: nil})
	f.repo.interested["event-1/member"] = true
	events, err := f.service.List(context.Background(), "server-a", "member", 20, "")
	if err != nil || len(events) != 1 || !events[0].Interested {
		t.Fatalf("list viewer RSVP state = %+v, %v", events, err)
	}
	f.repo.isInterestedErr = errors.New("rsvp lookup unavailable")
	if _, err := f.service.Get(context.Background(), "server-a", "event-1", "member"); err == nil || err.Error() != "rsvp lookup unavailable" {
		t.Fatalf("RSVP lookup failure should propagate, got %v", err)
	}
	if _, err := f.service.List(context.Background(), "server-a", "member", 20, ""); err == nil || err.Error() != "rsvp lookup unavailable" {
		t.Fatalf("list RSVP lookup failure should propagate, got %v", err)
	}
}

var _ repository.ServerEventRepository = (*serverEventRepoStub)(nil)
var _ repository.ServerRepository = (*serverEventServerRepoStub)(nil)
var _ repository.RoleRepository = (*serverEventRoleRepoStub)(nil)
var _ repository.ChannelRepository = (*serverEventChannelRepoStub)(nil)
var _ ChannelPermResolver = (*serverEventPermStub)(nil)
