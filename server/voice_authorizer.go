package main

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// voiceAdminAuthorizer implements ws.VoiceAdminAuthorizer — the WS-layer
// defense-in-depth check for voice moderation events (admin mute/deafen,
// move, disconnect) described in ws/hub_callbacks.go's VoiceAdminAuthorizer
// doc comment. It resolves the target's live voice channel and checks the
// actor's effective channel permissions there before the event is even
// dispatched to the service layer, which enforces the same permission
// again downstream.
type voiceAdminAuthorizer struct {
	voiceState   services.VoiceStateGetter
	permResolver services.ChannelPermResolver
}

// newVoiceAdminAuthorizer constructs the WS-layer authorizer. Wired in
// main.go right after registerHubCallbacks via hub.SetVoiceAdminAuthorizer.
func newVoiceAdminAuthorizer(voiceState services.VoiceStateGetter, permResolver services.ChannelPermResolver) *voiceAdminAuthorizer {
	return &voiceAdminAuthorizer{voiceState: voiceState, permResolver: permResolver}
}

// CanModerateVoiceTarget resolves the target's current voice channel and
// checks the actor's effective permissions there. Any failure to resolve
// (target not in voice, permission lookup error) fails closed — returns
// false — since the service layer is the only other gate and a false
// negative here just costs a redundant round trip, not a dropped legitimate
// action, while a false positive would be a moderation bypass.
func (a *voiceAdminAuthorizer) CanModerateVoiceTarget(ctx ws.VoiceModerationContext) bool {
	// Self-move exemption: MoveUser (services/voice_admin.go) allows a user
	// to move themselves with only PermConnectVoice in the TARGET channel
	// (no PermMoveMembers needed) — but VoiceModerationContext carries no
	// target channel, only the target user, so this WS-layer gate cannot
	// evaluate that check at all. Passing self-moves through unconditionally
	// avoids blocking legitimate self-moves; the service call still enforces
	// its own permission check before applying the move.
	if ctx.Action == "move" && ctx.ActorUserID == ctx.TargetUserID {
		return true
	}

	state := a.voiceState.GetUserVoiceState(ctx.TargetUserID)
	if state == nil || state.ChannelID == "" {
		return false
	}

	reqCtx, cancel := services.BroadcastContext()
	defer cancel()

	perms, err := a.permResolver.ResolveChannelPermissions(reqCtx, ctx.ActorUserID, state.ChannelID)
	if err != nil {
		return false
	}

	switch ctx.Action {
	case "mute":
		// client_voice.go's handleVoiceAdminStateUpdate sends the single
		// action string "mute" for BOTH server-mute and server-deafen
		// toggles (VoiceAdminStateUpdateData carries independent
		// IsServerMuted/IsServerDeafened pointers, but the WS→authorizer
		// call collapses them into one action). Accept either permission
		// here so a deafen-only moderator isn't rejected at this layer.
		// AdminUpdateState (services/voice_admin.go) still checks
		// PermMuteMembers / PermDeafenMembers independently against
		// whichever field is actually non-nil in the request.
		return perms.Has(models.PermMuteMembers) || perms.Has(models.PermDeafenMembers)
	case "move":
		// Only the target's CURRENT (source) channel can be checked here —
		// VoiceModerationContext has no target-channel field. MoveUser
		// itself re-resolves and requires PermMoveMembers in BOTH the
		// source and target channels before applying the move, so a
		// mismatch is still caught downstream; this is a deliberately
		// shallow first gate against the one channel this layer can see.
		return perms.Has(models.PermMoveMembers)
	case "disconnect":
		return perms.Has(models.PermMoveMembers)
	default:
		return false
	}
}
