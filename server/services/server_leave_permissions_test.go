package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestLeaveServerInvalidatesDepartingUserPermissions(t *testing.T) {
	inv := &memberInvalidator{}
	h := newJoinServerHarnessWithPermInvalidator(inv)
	h.serverRepo.GetByIDFn = func(context.Context, string) (*models.Server, error) { return &models.Server{OwnerID: "owner"}, nil }
	svc := h.svc

	if err := svc.LeaveServer(context.Background(), "server", "member"); err != nil {
		t.Fatal(err)
	}
	if len(inv.userCalls) != 1 || inv.userCalls[0] != "member" {
		t.Fatalf("invalidated users = %v", inv.userCalls)
	}
}

func TestLeaveServerRemovalFailurePreservesSession(t *testing.T) {
	inv := &memberInvalidator{}
	h := newJoinServerHarnessWithPermInvalidator(inv, func(string, string) { t.Error("disconnected voice after failed removal") })
	writeErr := errors.New("membership write failed")
	h.serverRepo.RemoveMemberFn = func(context.Context, string, string) error { return writeErr }
	h.hub.RemoveClientServerIDFn = func(string, string) { t.Error("removed live subscription after failed removal") }
	h.hub.BroadcastToServerFn = func(string, ws.Event) { t.Error("announced departure after failed removal") }
	if err := h.svc.LeaveServer(context.Background(), joinTestServerID, joinTestUserID); !errors.Is(err, writeErr) {
		t.Fatalf("leave error = %v, want membership write error", err)
	}
	if len(inv.userCalls) != 0 {
		t.Fatalf("invalidated permissions after failed removal: %v", inv.userCalls)
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
	t.Cleanup(cache.(*cachingPermResolver).permCache.Close)
	h.svc.(*serverService).permInvalidator = cache
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
			voice, _ := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				return &models.Channel{ID: id, ServerID: activeServer, Type: models.ChannelTypeVoice}, nil
			}})
			h := newJoinServerHarness(voice.DisconnectServerMember)
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
			h := newJoinServerHarness(voice.DisconnectServerMember)
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

func TestLeaveConstructorActivityNotificationFollowsMembershipWrite(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "committed", true: "failed"}[failed], func(t *testing.T) {
			activity := &recordingGameActivityInvalidator{}
			h := newJoinServerHarnessWithActivity(activity)
			if failed {
				h.serverRepo.RemoveMemberFn = func(context.Context, string, string) error {
					return errors.New("membership write failed")
				}
			}
			err := h.svc.LeaveServer(context.Background(), joinTestServerID, joinTestUserID)
			if failed {
				if err == nil || len(activity.calls) != 0 {
					t.Fatalf("failed leave notified activity: err=%v calls=%+v", err, activity.calls)
				}
			} else if err != nil || len(activity.calls) != 1 || activity.calls[0] != (gameActivityInvalidationCall{kind: "removed", a: joinTestServerID, b: joinTestUserID}) {
				t.Fatalf("committed leave notification: err=%v calls=%+v", err, activity.calls)
			}
		})
	}
}
