package main

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Regression coverage for the three fail-open traps called out in the P1.1
// work item: (a) "mute" must accept PermMuteMembers OR PermDeafenMembers
// since client_voice.go sends the same action string for both toggles, (b)
// self-move must pass unconditionally regardless of resolved permissions,
// (c) a permission-resolve error must fail closed (false), not fail open.

func stateFor(channelID string) *models.VoiceState {
	return &models.VoiceState{ChannelID: channelID}
}

func TestVoiceAdminAuthorizer_Mute_AcceptsMuteOrDeafenPerm(t *testing.T) {
	cases := []struct {
		name  string
		perms models.Permission
		want  bool
	}{
		{"mute-only perm", models.PermMuteMembers, true},
		{"deafen-only perm", models.PermDeafenMembers, true},
		{"both perms", models.PermMuteMembers | models.PermDeafenMembers, true},
		{"neither perm", models.PermConnectVoice, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			voiceState := &testutil.MockVoiceStateGetter{
				GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
			}
			permResolver := &testutil.MockChannelPermResolver{
				ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
					return tc.perms, nil
				},
			}
			authz := newVoiceAdminAuthorizer(voiceState, permResolver)

			got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
				ActorUserID:  "mod-1",
				TargetUserID: "target-1",
				Action:       "mute",
			})
			if got != tc.want {
				t.Errorf("CanModerateVoiceTarget(mute) = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVoiceAdminAuthorizer_Move_SelfMoveAlwaysAllowed(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return nil }, // even with no voice state at all
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			t.Fatal("self-move must not consult the permission resolver at all")
			return 0, nil
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "user-1",
		TargetUserID: "user-1",
		Action:       "move",
	})
	if !got {
		t.Error("self-move must always be authorized at the WS layer; MoveUser's own permission check gates it downstream")
	}
}

func TestVoiceAdminAuthorizer_Move_OtherUserRequiresMoveMembers(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return models.PermConnectVoice, nil // no PermMoveMembers
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "move",
	})
	if got {
		t.Error("moving another user without PermMoveMembers in the source channel must be denied")
	}
}

func TestVoiceAdminAuthorizer_Move_OtherUserAllowedWithMoveMembers(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return models.PermMoveMembers, nil
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "move",
	})
	if !got {
		t.Error("moving another user WITH PermMoveMembers in the source channel must be allowed")
	}
}

func TestVoiceAdminAuthorizer_Disconnect_RequiresMoveMembers(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return models.PermMoveMembers, nil
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "disconnect",
	})
	if !got {
		t.Error("disconnect with PermMoveMembers must be allowed")
	}
}

func TestVoiceAdminAuthorizer_FailsClosedOnResolveError(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return 0, errors.New("db unavailable")
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "disconnect",
	})
	if got {
		t.Error("a permission-resolve error must fail closed (deny), not fail open")
	}
}

func TestVoiceAdminAuthorizer_FailsClosedWhenTargetNotInVoice(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return nil },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			t.Fatal("should not resolve permissions when the target has no voice state")
			return 0, nil
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "mute",
	})
	if got {
		t.Error("target with no voice state must be denied, not allowed")
	}
}

func TestVoiceAdminAuthorizer_UnknownActionDenied(t *testing.T) {
	voiceState := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState { return stateFor("chan-1") },
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(ctx context.Context, userID, channelID string) (models.Permission, error) {
			return models.PermAdmin, nil
		},
	}
	authz := newVoiceAdminAuthorizer(voiceState, permResolver)

	got := authz.CanModerateVoiceTarget(ws.VoiceModerationContext{
		ActorUserID:  "mod-1",
		TargetUserID: "target-1",
		Action:       "unknown-action",
	})
	if got {
		t.Error("an unrecognized action must be denied")
	}
}
