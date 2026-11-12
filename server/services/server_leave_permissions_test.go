package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/pkg"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

func TestLeaveServerInvalidatesDepartingUserPermissions(t *testing.T) {
	inv := &memberInvalidator{}
	svc := &serverService{
		serverRepo: &testutil.MockServerRepo{GetByIDFn: func(context.Context, string) (*models.Server, error) {
			return &models.Server{OwnerID: "owner"}, nil
		}},
		hub: &testutil.MockEventPublisher{},
	}
	svc.SetPermInvalidator(inv)
	if err := svc.LeaveServer(context.Background(), "server", "member"); err != nil {
		t.Fatal(err)
	}
	if len(inv.userCalls) != 1 || inv.userCalls[0] != "member" {
		t.Fatalf("invalidated users = %v", inv.userCalls)
	}
}
func TestPrivateChannelPermissionsAcrossLeaveAndRejoin(t *testing.T) {
	ctx := context.Background()
	h := newJoinServerHarness()
	roles := []models.Role{{ID: "reader", Permissions: models.PermReadMessages | models.PermViewChannel}}
	h.roleRepo.GetByUserIDAndServerFn = func(context.Context, string, string) ([]models.Role, error) { return roles, nil }
	h.serverRepo.RemoveMemberFn = func(context.Context, string, string) error { roles = nil; return nil }
	h.roleRepo.AssignToUserFn = func(_ context.Context, _, roleID, _ string) error {
		roles = []models.Role{{ID: roleID, Permissions: models.PermViewChannel}}
		return nil
	}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: joinTestServerID, Type: models.ChannelTypeText}, nil
	}}
	cache := NewChannelPermissionService(&testutil.MockChannelPermRepo{}, h.roleRepo, channels, h.hub)
	h.svc.SetPermInvalidator(cache)
	check := func(want models.Permission) {
		t.Helper()
		got, err := cache.ResolveChannelPermissions(ctx, joinTestUserID, "private")
		if err != nil || got != want {
			t.Fatalf("private channel permissions = %v, want %v, err = %v", got, want, err)
		}
	}
	check(models.PermViewChannel | models.PermReadMessages)
	if err := h.svc.LeaveServer(ctx, joinTestServerID, joinTestUserID); err != nil {
		t.Fatal(err)
	}
	check(0)
	if _, err := h.svc.JoinServer(ctx, joinTestUserID, joinTestCode); err != nil {
		t.Fatal(err)
	}
	check(models.PermViewChannel)
}

func TestLeaveServerDisconnectsVoiceOnlyInDepartedServer(t *testing.T) {
	for _, activeServer := range []string{joinTestServerID, "other-server"} {
		t.Run(activeServer, func(t *testing.T) {
			h := newJoinServerHarness()
			voice, _ := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: activeServer, Type: models.ChannelTypeVoice}, nil
			}})
			h.svc.SetMembershipVoiceCleanup(voice.DisconnectServerMember)
			if err := voice.JoinChannel(joinTestUserID, "reader", "Reader", "", "voice", false, false); err != nil {
				t.Fatal(err)
			}
			if err := h.svc.LeaveServer(context.Background(), joinTestServerID, joinTestUserID); err != nil {
				t.Fatal(err)
			}
			if active := voice.GetUserVoiceState(joinTestUserID) != nil; active != (activeServer != joinTestServerID) {
				t.Fatalf("voice active after leaving %s = %v", joinTestServerID, active)
			}
		})
	}
}

func TestLeaveServerFencesVoiceJoinAfterAdmission(t *testing.T) {
	for _, activeServer := range []string{joinTestServerID, "other-server"} {
		t.Run(activeServer, func(t *testing.T) {
			voice, _ := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
				return &models.Channel{ID: "voice", ServerID: activeServer, Type: models.ChannelTypeVoice}, nil
			}})
			h := newJoinServerHarness()
			h.svc.SetMembershipVoiceCleanup(voice.DisconnectServerMember)
			admitted, resume := make(chan struct{}), make(chan struct{})
			voice.(*voiceService).livekitGetter = &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
				close(admitted)
				<-resume
				return nil, nil
			}}
			result := make(chan error, 1)
			go func() { result <- voice.JoinChannel(joinTestUserID, "reader", "Reader", "", "voice", false, false) }()
			select {
			case <-admitted:
			case err := <-result:
				t.Fatalf("join ended before admission: %v", err)
			}
			err := h.svc.LeaveServer(context.Background(), joinTestServerID, joinTestUserID)
			close(resume)
			joinErr := <-result
			if err != nil {
				t.Fatal(err)
			}
			state := voice.GetUserVoiceState(joinTestUserID)
			if activeServer != joinTestServerID {
				if joinErr != nil || state == nil || state.ServerID != activeServer {
					t.Fatalf("unrelated join returned %v, state = %+v", joinErr, state)
				}
				return
			}
			if !errors.Is(joinErr, pkg.ErrForbidden) || state != nil {
				t.Fatalf("stale join returned %v, state = %+v", joinErr, state)
			}

		})
	}
}
