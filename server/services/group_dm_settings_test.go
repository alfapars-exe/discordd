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

type groupPrivateSettingsRepo struct {
	repository.GroupDMRepository
	muted  bool
	writes int
}

func (r *groupPrivateSettingsRepo) GetByID(context.Context, string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: "group", KeyEpoch: 1}, nil
}
func (r *groupPrivateSettingsRepo) IsMember(_ context.Context, _, user string) (bool, error) {
	return user == "alice" || user == "bob", nil
}
func (r *groupPrivateSettingsRepo) ListMemberIDs(context.Context, string) ([]string, error) {
	return []string{"alice", "bob"}, nil
}
func (r *groupPrivateSettingsRepo) ListForUser(context.Context, string) ([]models.GroupDM, error) {
	return []models.GroupDM{{ID: "group", KeyEpoch: 1}}, nil
}
func (r *groupPrivateSettingsRepo) GetReadState(_ context.Context, group, user string) (*models.GroupDMReadState, error) {
	return &models.GroupDMReadState{GroupID: group, IsMuted: r.muted && user == "bob", SettingsRevision: 1, Revision: 4, UnreadCount: 2}, nil
}
func (r *groupPrivateSettingsRepo) SetMuted(ctx context.Context, group, user string, value bool) (*models.GroupDMReadState, error) {
	r.writes++
	r.muted = value
	return r.GetReadState(ctx, group, user)
}
func TestGroupDMSettingsProjectionAndBroadcastRemainRecipientPrivate(t *testing.T) {
	repo := &groupPrivateSettingsRepo{}
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: id}, nil
	}}
	events := map[string]ws.Event{}
	hub := &testutil.MockBroadcaster{BroadcastToUserFn: func(id string, event ws.Event) { events[id] = event }}
	service := &groupDMService{groups: repo, users: users, hub: hub}
	ctx := context.Background()
	if _, err := service.SetMuted(ctx, "group", "outsider", true); !errors.Is(err, pkg.ErrNotFound) || repo.writes != 0 {
		t.Fatalf("outsider changed setting: %v writes=%d", err, repo.writes)
	}
	if _, err := service.SetMuted(ctx, "group", "bob", true); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events["bob"].Op != ws.OpGroupDMRead {
		t.Fatalf("setting broadcast to another member: %+v", events)
	}
	for _, id := range []string{"alice", "bob"} {
		g, err := service.Get(ctx, "group", id)
		if err != nil || g.IsMuted != (id == "bob") {
			t.Fatalf("get user=%s group=%+v err=%v", id, g, err)
		}
		groups, err := service.List(ctx, id)
		if err != nil || len(groups) != 1 || groups[0].IsMuted != (id == "bob") {
			t.Fatalf("list user=%s groups=%+v err=%v", id, groups, err)
		}
	}
	if _, err := service.broadcastGroup(ctx, "group", ws.OpGroupDMUpdate); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"alice", "bob"} {
		g := events[id].Data.(*models.GroupDM)
		if g.IsMuted != (id == "bob") {
			t.Fatalf("shared update leaked settings to %s: %+v", id, g)
		}
	}
}
