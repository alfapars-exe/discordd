package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type groupReadFixture struct {
	repository.GroupDMRepository
	member  bool
	writes  int
	failure error
}

func (f *groupReadFixture) GetByID(_ context.Context, id string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: id}, nil
}
func (f *groupReadFixture) IsMember(context.Context, string, string) (bool, error) {
	return f.member, nil
}
func (f *groupReadFixture) ListMemberIDs(context.Context, string) ([]string, error) {
	return []string{"reader"}, nil
}
func (f *groupReadFixture) GetReadState(_ context.Context, group, user string) (*models.GroupDMReadState, error) {
	if f.failure != nil {
		return nil, f.failure
	}
	return &models.GroupDMReadState{GroupID: group, Revision: 7}, nil
}
func (f *groupReadFixture) MarkUnreadFrom(_ context.Context, group, user, message string) (*models.GroupDMReadState, error) {
	f.writes++
	if f.failure != nil {
		return nil, f.failure
	}
	if group != "group" || user != "reader" || message != "message" {
		return nil, pkg.ErrNotFound
	}
	return &models.GroupDMReadState{GroupID: group, UnreadCount: 3, Revision: 7}, nil
}

func TestGroupDMReadBroadcastFailureDoesNotFailCommittedMessage(t *testing.T) {
	f := &groupReadFixture{member: true, failure: errors.New("read snapshot unavailable")}
	hub := &testutil.MockBroadcaster{}
	called := false
	hub.BroadcastToUsersFn = func(ids []string, event ws.Event) {
		called = true
		if event.Op != ws.OpGroupDMMessageCreate {
			t.Fatal(event.Op)
		}
	}
	svc := &groupDMService{groups: f, hub: hub}
	if err := svc.BroadcastMessage(context.Background(), &models.GroupDMMessage{ID: "committed", GroupID: "group"}); err != nil {
		t.Fatalf("committed message reported failure: %v", err)
	}
	if !called {
		t.Fatal("message event lost")
	}
}
func TestGroupDMUnreadRequiresMembershipAndBroadcastsOnlyOwner(t *testing.T) {
	f := &groupReadFixture{member: true}
	hub := &testutil.MockBroadcaster{}
	var recipients []string
	hub.BroadcastToUserFn = func(user string, event ws.Event) {
		recipients = append(recipients, user)
		state, ok := event.Data.(*models.GroupDMReadState)
		if event.Op != ws.OpGroupDMRead || !ok || state.Revision != 7 {
			t.Fatalf("event=%+v", event)
		}
	}
	svc := &groupDMService{groups: f, hub: hub}
	state, err := svc.MarkUnreadFrom(context.Background(), "group", "reader", "message")
	if err != nil || state.UnreadCount != 3 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if len(recipients) != 1 || recipients[0] != "reader" {
		t.Fatalf("recipients=%v", recipients)
	}
	f.member = false
	if _, err := svc.MarkUnreadFrom(context.Background(), "group", "reader", "message"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal(err)
	}
	if f.writes != 1 || len(recipients) != 1 {
		t.Fatal("nonmember mutated/broadcast read state")
	}
	f.member = true
	f.failure = pkg.ErrNotFound
	if _, err := svc.MarkUnreadFrom(context.Background(), "group", "reader", "foreign"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal(err)
	}
	if len(recipients) != 1 {
		t.Fatal("failed rewind broadcast success")
	}
	if _, err := svc.MarkUnreadFrom(context.Background(), "group", "reader", " "); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("blank id=%v", err)
	}
}
