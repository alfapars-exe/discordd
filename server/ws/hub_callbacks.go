package ws

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── Callback Type Definitions ───
//
// Hub publishes events back into the service layer via callbacks set
// at startup time in main.go. Each callback name and signature mirrors
// one event the WS handler can produce, so adding a new event = add a
// callback type + an On* registration method here, then wire it up in
// main.go. Storing as struct fields (vs slice of listeners) keeps the
// hot-path lookup zero-cost; we don't currently need multi-listener
// dispatch.

// UserConnectionCallback is called on first-connect and full-disconnect.
// Second arg is unused (kept for signature compatibility).
type UserConnectionCallback func(userID, _ string)

// ─── Voice Callback Types ───

// VoiceJoinCallback — user wants to join a voice channel.
// displayName may be empty if the user hasn't set one.
type VoiceJoinCallback func(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool)

// VoiceLeaveCallback — user wants to leave a voice channel.
type VoiceLeaveCallback func(userID string)

// VoiceStateUpdateCallback — user toggled mute/deafen/stream.
// Nil pointers mean "no change" (partial update).
type VoiceStateUpdateCallback func(userID string, isMuted, isDeafened, isStreaming *bool)

// PresenceManualUpdateCallback — user changed presence (manual or auto-idle).
// isAuto distinguishes auto-idle from manual status changes (only manual persists to pref_status).
type PresenceManualUpdateCallback func(userID string, status string, isAuto bool)

// VoiceAdminStateUpdateCallback — admin server-muted/deafened a user.
// Nil pointers mean "no change" (partial update).
type VoiceAdminStateUpdateCallback func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool)

// VoiceMoveUserCallback — authorized user moved someone between voice channels.
type VoiceMoveUserCallback func(moverUserID, targetUserID, targetChannelID string)

// VoiceDisconnectUserCallback — authorized user kicked someone from voice.
type VoiceDisconnectUserCallback func(disconnecterUserID, targetUserID string)

// ScreenShareWatchCallback — user started/stopped watching a screen share.
type ScreenShareWatchCallback func(viewerUserID, streamerUserID string, watching bool)

// VoiceActivityCallback — client reports activity (mouse/keyboard/VAD/screen share).
type VoiceActivityCallback func(userID string)

// ─── P2P Call Callback Types ───

type P2PCallInitiateCallback func(callerID string, data P2PCallInitiateData)
type P2PCallAcceptCallback func(userID string, data P2PCallAcceptData)
type P2PCallDeclineCallback func(userID string, data P2PCallDeclineData)
type P2PCallEndCallback func(userID string)

// P2PSignalCallback — WebRTC signaling data relayed to the other peer.
type P2PSignalCallback func(senderID string, data P2PSignalData)

// ChannelTypingCallback — typing indicator in a server channel.
// Wired in main.go: validates channel access, broadcasts to server members only.
type ChannelTypingCallback func(senderUserID, senderUsername, channelID string)

// VoiceAdminAuthorizer is the WS-layer defense-in-depth check for moderator
// actions delivered over WebSocket (admin mute/deafen, move user, disconnect
// user). The service layer also enforces the permission downstream, but
// rejecting unauthorized events here prevents bogus traffic from ever
// reaching the service goroutine pool. It also fail-closes the system —
// if a service callback ever forgets its own check, the WS layer still
// blocks the attack.
//
// Returns true iff the actor holds the necessary moderation permission
// over the target. Nil-safe: when the authorizer isn't wired (tests,
// bootstrap), the check is skipped and the legacy single-layer behaviour
// applies.
type VoiceAdminAuthorizer interface {
	CanModerateVoiceTarget(ctx VoiceModerationContext) bool
}

// VoiceModerationContext is the input to a defense-in-depth authorization
// check. The authorizer typically looks up the target user's current voice
// channel, resolves the channel's server, and checks the actor's server
// permissions there.
type VoiceModerationContext struct {
	ActorUserID  string
	TargetUserID string
	// Action is one of "mute", "move", "disconnect" — drives which permission
	// bit the authorizer requires.
	Action string
}

// ─── DM Callback Types ───

// DMTypingCallback — typing indicator in a DM channel.
// Wired in main.go: looks up DM channel member, broadcasts to the other user.
type DMTypingCallback func(senderUserID, senderUsername, dmChannelID string)

// ─── Callback Registration Methods ───

// OnUserFirstConnect sets the callback for a user's first WS connection.
// Not fired for additional tabs/connections from the same user.
func (h *Hub) OnUserFirstConnect(cb UserConnectionCallback) {
	h.onUserFirstConnect = cb
}

// OnUserFullyDisconnected sets the callback for when a user's last connection closes.
func (h *Hub) OnUserFullyDisconnected(cb UserConnectionCallback) {
	h.onUserFullyDisconnected = cb
}

// SetAppLogger sets the structured app logger for WS events.
func (h *Hub) SetAppLogger(logger AppLogger) {
	h.appLogger = logger
}

// logEvent is a helper that safely logs via appLogger if set.
//
// context.Background(): logEvent's callers are WS hub event handlers, not
// HTTP requests, so there is no request-scoped context to thread through
// without widening this helper's signature across every one of its call
// sites (out of scope for P3.8's request_id addition — see AppLogService.Log's
// doc comment).
func (h *Hub) logEvent(level models.LogLevel, category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if h.appLogger != nil {
		h.appLogger.Log(context.Background(), level, category, userID, nil, message, metadata)
	}
}

// OnPresenceManualUpdate sets the callback for manual presence changes.
func (h *Hub) OnPresenceManualUpdate(cb PresenceManualUpdateCallback) {
	h.onPresenceManualUpdate = cb
}

func (h *Hub) OnVoiceJoin(cb VoiceJoinCallback) {
	h.onVoiceJoin = cb
}

func (h *Hub) OnVoiceLeave(cb VoiceLeaveCallback) {
	h.onVoiceLeave = cb
}

func (h *Hub) OnVoiceStateUpdate(cb VoiceStateUpdateCallback) {
	h.onVoiceStateUpdate = cb
}

func (h *Hub) OnVoiceAdminStateUpdate(cb VoiceAdminStateUpdateCallback) {
	h.onVoiceAdminStateUpdate = cb
}

func (h *Hub) OnVoiceMoveUser(cb VoiceMoveUserCallback) {
	h.onVoiceMoveUser = cb
}

func (h *Hub) OnVoiceDisconnectUser(cb VoiceDisconnectUserCallback) {
	h.onVoiceDisconnectUser = cb
}

func (h *Hub) OnVoiceActivity(cb VoiceActivityCallback) {
	h.onVoiceActivity = cb
}

func (h *Hub) OnP2PCallInitiate(cb P2PCallInitiateCallback) {
	h.onP2PCallInitiate = cb
}

func (h *Hub) OnP2PCallAccept(cb P2PCallAcceptCallback) {
	h.onP2PCallAccept = cb
}

func (h *Hub) OnP2PCallDecline(cb P2PCallDeclineCallback) {
	h.onP2PCallDecline = cb
}

func (h *Hub) OnP2PCallEnd(cb P2PCallEndCallback) {
	h.onP2PCallEnd = cb
}

func (h *Hub) OnP2PSignal(cb P2PSignalCallback) {
	h.onP2PSignal = cb
}

func (h *Hub) OnChannelTyping(cb ChannelTypingCallback) {
	h.onChannelTyping = cb
}

func (h *Hub) OnDMTyping(cb DMTypingCallback) {
	h.onDMTyping = cb
}

func (h *Hub) OnScreenShareWatch(cb ScreenShareWatchCallback) {
	h.onScreenShareWatch = cb
}

// SetVoiceAdminAuthorizer wires the WS-layer defense-in-depth check for
// voice moderation events. Nil-safe (legacy behavior if absent).
func (h *Hub) SetVoiceAdminAuthorizer(a VoiceAdminAuthorizer) {
	h.voiceAdminAuthz = a
}

// authorizeVoiceModeration returns true if the action is allowed (or no
// authorizer is wired). Centralizes the nil-check.
func (h *Hub) authorizeVoiceModeration(actorID, targetID, action string) bool {
	if h.voiceAdminAuthz == nil {
		return true // No authorizer wired — fall through to legacy single-layer check.
	}
	return h.voiceAdminAuthz.CanModerateVoiceTarget(VoiceModerationContext{
		ActorUserID:  actorID,
		TargetUserID: targetID,
		Action:       action,
	})
}
