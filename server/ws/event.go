package ws

// Event is the WebSocket message format.
// Seq is a monotonic counter for gap detection on the client side.
type Event struct {
	Op       string `json:"op"`
	Data     any    `json:"d,omitempty"`
	Seq      int64  `json:"seq,omitempty"`
	ServerID string `json:"server_id,omitempty"`
}

// ─── Operation Constants ───

// Client -> Server
const (
	OpHeartbeat      = "heartbeat"
	OpTyping         = "typing"
	OpPresenceUpdate = "presence_update"
)

// Server -> Client
const (
	OpReady          = "ready"
	OpHeartbeatAck   = "heartbeat_ack"
	OpMessageCreate  = "message_create"
	OpMessageUpdate  = "message_update"
	OpMessageDelete  = "message_delete"
	OpChannelCreate  = "channel_create"
	OpChannelUpdate  = "channel_update"
	OpChannelDelete  = "channel_delete"
	OpCategoryCreate = "category_create"
	OpCategoryUpdate = "category_update"
	OpCategoryDelete = "category_delete"
	OpTypingStart    = "typing_start"
	OpPresence       = "presence_update"
	OpMemberJoin          = "member_join"
	OpMemberLeave         = "member_leave"
	OpMemberUpdate        = "member_update"
	OpMemberTimeout       = "member_timeout"        // data: server_id, user_id, expires_at, reason
	OpMemberTimeoutRemove = "member_timeout_remove" // data: server_id, user_id
	OpRoleCreate     = "role_create"
	OpRoleUpdate     = "role_update"
	OpRoleDelete     = "role_delete"
	OpRolesReorder   = "roles_reorder"
	OpServerUpdate   = "server_update"
	OpServerCreate   = "server_create"
	OpServerDelete   = "server_delete"

	OpMessagePin   = "message_pin"
	OpMessageUnpin = "message_unpin"

	OpReactionUpdate = "reaction_update"

	OpChannelPermissionUpdate = "channel_permission_update"
	OpChannelPermissionDelete = "channel_permission_delete"

	OpChannelReorder  = "channel_reorder"
	OpCategoryReorder = "category_reorder"

	// DM operations
	OpDMChannelCreate       = "dm_channel_create"
	OpDMMessageCreate       = "dm_message_create"
	OpDMMessageUpdate       = "dm_message_update"
	OpDMMessageDelete       = "dm_message_delete"
	OpDMReactionUpdate      = "dm_reaction_update"
	OpDMTypingStart         = "dm_typing_start"
	OpDMMessagePin          = "dm_message_pin"
	OpDMMessageUnpin        = "dm_message_unpin"
	OpDMSettingsUpdate      = "dm_settings_update"
	OpDMRequestAccept       = "dm_request_accept"
	OpDMRequestDecline      = "dm_request_decline"
	OpDMChannelStatusChange = "dm_channel_status_change"

	// Block operations
	OpUserBlock   = "user_block"
	OpUserUnblock = "user_unblock"

	// Voice operations
	OpVoiceStateUpdate        = "voice_state_update"
	OpVoiceStatesSync         = "voice_states_sync"
	OpScreenShareViewerUpdate = "screen_share_viewer_update"

	// Audit operations — moderation event broadcast for audit channels.
	// Sent only to users with audit-view permission for the originating server.
	OpAuditEvent = "audit_event"

	// Friend operations
	OpFriendRequestCreate  = "friend_request_create"
	OpFriendRequestAccept  = "friend_request_accept"
	OpFriendRequestDecline = "friend_request_decline"
	OpFriendRemove         = "friend_remove"
)

// Client -> Server voice operations
const (
	OpVoiceJoin             = "voice_join"
	OpVoiceLeave            = "voice_leave"
	OpVoiceStateUpdateReq   = "voice_state_update_request"
	OpVoiceAdminStateUpdate = "voice_admin_state_update"
	OpVoiceMoveUser         = "voice_move_user"
	OpVoiceDisconnectUser   = "voice_disconnect_user"
	OpScreenShareWatch      = "screen_share_watch"
	OpVoiceActivity         = "voice_activity" // client reports mouse/keyboard/VAD/screen share activity
)

// Server -> Client voice moderation
const (
	OpVoiceForceMove       = "voice_force_move"
	OpVoiceForceDisconnect = "voice_force_disconnect"
	OpVoiceAFKKick         = "voice_afk_kick" // user kicked for inactivity
	// OpVoicePassphraseRotated — server notifies remaining voice-channel members
	// that the SFrame E2EE passphrase has been rotated (e.g. after a kick or ban).
	// Clients must apply the new passphrase to their LiveKit room so that any
	// previously-disclosed passphrase no longer decrypts future traffic.
	OpVoicePassphraseRotated = "voice_passphrase_rotated"
)

// P2P Call signaling flow:
// 1. Caller: p2p_call_initiate -> Server validate -> Receiver: p2p_call_initiate
// 2. Receiver: p2p_call_accept -> Server update -> Caller: p2p_call_accept
// 3. WebRTC negotiation: p2p_signal relay (SDP offer/answer/ICE candidates)
// 4. Either: p2p_call_end -> Server cleanup -> Other: p2p_call_end
const (
	OpP2PCallInitiate = "p2p_call_initiate"
	OpP2PCallAccept   = "p2p_call_accept"
	OpP2PCallDecline  = "p2p_call_decline"
	OpP2PCallEnd      = "p2p_call_end"
	OpP2PSignal       = "p2p_signal"
	OpP2PCallBusy     = "p2p_call_busy"
)

// E2EE operations
const (
	OpDeviceKeyChange  = "device_key_change"
	OpPrekeyLow        = "prekey_low"
	OpGroupSessionNew  = "group_session_new"
	OpDeviceListUpdate = "device_list_update"
)

// Soundboard operations
const (
	OpSoundboardCreate = "soundboard_sound_create"
	OpSoundboardUpdate = "soundboard_sound_update"
	OpSoundboardDelete = "soundboard_sound_delete"
	OpSoundboardPlay   = "soundboard_play"
)

// Badge operations
const (
	OpBadgeAssign   = "badge_assign"
	OpBadgeUnassign = "badge_unassign"
)

// BotReadableOps is the curated subset of server->client events a bot
// connection receives. Deliberately minimal for the MVP: message lifecycle,
// reactions, member join/leave, typing, and channel lifecycle. Voice/screen,
// DM, E2EE/device, presence, audit, and friend events are withheld — bots
// have no use for them and broadcasting them widens the exfiltration surface.
var BotReadableOps = map[string]bool{
	OpMessageCreate:  true,
	OpMessageUpdate:  true,
	OpMessageDelete:  true,
	OpReactionUpdate: true,
	OpMessagePin:     true,
	OpMessageUnpin:   true,
	OpMemberJoin:     true,
	OpMemberLeave:    true,
	OpMemberUpdate:   true,
	OpTypingStart:    true,
	OpChannelCreate:  true,
	OpChannelUpdate:  true,
	OpChannelDelete:  true,
}

// ReadyData is the payload sent to a client on initial connection.
type ReadyData struct {
	OnlineUserIDs   []string          `json:"online_user_ids"`
	Servers         []ReadyServerItem `json:"servers"`
	MutedServerIDs  []string          `json:"muted_server_ids"`
	MutedChannelIDs []string          `json:"muted_channel_ids"`
	PrefStatus      string            `json:"pref_status"`
}

// ReadyServerItem is a minimal server representation for the ready event.
// Separate from models to avoid ws -> models coupling.
type ReadyServerItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

type PresenceData struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
	IsAuto bool   `json:"is_auto,omitempty"`
}

type TypingData struct {
	ChannelID string `json:"channel_id"`
}

type TypingStartData struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	ChannelID string `json:"channel_id"`
}

type DMTypingStartData struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DMChannelID string `json:"dm_channel_id"`
}

// ─── Voice Event Data ───

type VoiceJoinData struct {
	ChannelID  string `json:"channel_id"`
	IsMuted    bool   `json:"is_muted,omitempty"`
	IsDeafened bool   `json:"is_deafened,omitempty"`
}

// VoiceStateUpdateRequestData — nil pointer = no change (partial update).
type VoiceStateUpdateRequestData struct {
	IsMuted     *bool `json:"is_muted,omitempty"`
	IsDeafened  *bool `json:"is_deafened,omitempty"`
	IsStreaming *bool `json:"is_streaming,omitempty"`
}

// VoiceAdminStateUpdateData — admin server mute/deafen request.
type VoiceAdminStateUpdateData struct {
	TargetUserID     string `json:"target_user_id"`
	IsServerMuted    *bool  `json:"is_server_muted,omitempty"`
	IsServerDeafened *bool  `json:"is_server_deafened,omitempty"`
}

type VoiceMoveUserData struct {
	TargetUserID    string `json:"target_user_id"`
	TargetChannelID string `json:"target_channel_id"`
}

type VoiceDisconnectUserData struct {
	TargetUserID string `json:"target_user_id"`
}

// VoiceForceMoveData — server tells client to switch to a different channel.
type VoiceForceMoveData struct {
	ChannelID string `json:"channel_id"`
}

// VoiceStateUpdateBroadcast — broadcast payload when a user's voice state changes.
type VoiceStateUpdateBroadcast struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
	Action           string `json:"action"` // "join", "leave", "update"
}

// VoiceStatesSyncData — bulk voice state sync sent on connection.
type VoiceStatesSyncData struct {
	States []VoiceStateItem `json:"states"`
}

// VoiceStateItem mirrors models.VoiceState without creating a ws -> models dependency.
type VoiceStateItem struct {
	UserID           string `json:"user_id"`
	ChannelID        string `json:"channel_id"`
	ServerID         string `json:"server_id"`
	Username         string `json:"username"`
	DisplayName      string `json:"display_name"`
	AvatarURL        string `json:"avatar_url"`
	IsMuted          bool   `json:"is_muted"`
	IsDeafened       bool   `json:"is_deafened"`
	IsStreaming      bool   `json:"is_streaming"`
	IsServerMuted    bool   `json:"is_server_muted"`
	IsServerDeafened bool   `json:"is_server_deafened"`
	// ScreenShareViewers — user IDs currently watching this user's screen
	// share. Only populated for streamers (IsStreaming=true) and only when
	// the requester's client has access to those identities. Omitted from
	// the wire when empty so older clients that don't read it are unaffected.
	ScreenShareViewers []string `json:"screen_share_viewers,omitempty"`
}

// ScreenShareWatchData — client tells server they started/stopped watching a screen share.
type ScreenShareWatchData struct {
	StreamerUserID string `json:"streamer_user_id"`
	Watching       bool   `json:"watching"`
}

// ScreenShareViewerUpdateData — broadcast when viewer count changes for a screen share.
type ScreenShareViewerUpdateData struct {
	StreamerUserID string `json:"streamer_user_id"`
	ChannelID      string `json:"channel_id"`
	ViewerCount    int    `json:"viewer_count"`
	ViewerUserID   string `json:"viewer_user_id"` // who joined/left
	Action         string `json:"action"`         // "join" or "leave"
}

// VoiceAFKKickData — sent to user before AFK disconnect.
type VoiceAFKKickData struct {
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	ServerName  string `json:"server_name"`
}

// VoicePassphraseRotatedData — sent to all remaining members of a voice
// channel after the SFrame E2EE passphrase is rotated. The kicked/banned
// user does NOT receive this event (they no longer have voice access).
// Clients re-key their LiveKit room with the new passphrase so any
// previously-leaked passphrase can't decrypt future traffic.
type VoicePassphraseRotatedData struct {
	ChannelID  string `json:"channel_id"`
	Passphrase string `json:"passphrase"`
}

// ─── P2P Call Event Data ───

type P2PCallInitiateData struct {
	ReceiverID string `json:"receiver_id"`
	CallType   string `json:"call_type"` // "voice" or "video"
}

type P2PCallAcceptData struct {
	CallID string `json:"call_id"`
}

type P2PCallDeclineData struct {
	CallID string `json:"call_id"`
}

// P2PSignalData carries WebRTC SDP/ICE data. Server relays without inspecting.
type P2PSignalData struct {
	CallID    string `json:"call_id"`
	Type      string `json:"type"` // "offer", "answer", "ice-candidate"
	SDP       string `json:"sdp,omitempty"`
	Candidate any    `json:"candidate,omitempty"`
}
