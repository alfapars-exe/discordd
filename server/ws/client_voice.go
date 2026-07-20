// Voice channel event handlers (join/leave, state, moderation, screen share).
package ws

import (
	"encoding/json"
)

// ─── Voice Event Handlers ───

func (c *Client) handleVoiceJoin(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceJoinData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.ChannelID == "" {
		dispatchLogger.Warn("voice_join without channel_id", "user_id", c.userID)
		return
	}

	// Note: no voice_replaced broadcast here. Real multi-session handover is
	// already signaled by the SFU's DUPLICATE_IDENTITY disconnect on the
	// superseded session; adding a WS broadcast caused a ghost-pointer race
	// (stale Client struct in the hub map received the event after reconnect,
	// disconnecting the live session). Client handles DUPLICATE_IDENTITY
	// directly in VoiceProvider.handleDisconnected.

	if c.hub.onVoiceJoin != nil {
		info := c.hub.getUserInfo(c.userID)
		go c.hub.onVoiceJoin(c.userID, info.Username, info.DisplayName, info.AvatarURL, data.ChannelID, data.IsMuted, data.IsDeafened)
	}
}

func (c *Client) handleVoiceLeave() {
	if c.hub.onVoiceLeave != nil {
		go c.hub.onVoiceLeave(c.userID)
	}
}

func (c *Client) handleVoiceActivity() {
	if c.hub.onVoiceActivity != nil {
		go c.hub.onVoiceActivity(c.userID)
	}
}

func (c *Client) handleVoiceStateUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceStateUpdateRequestData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if c.hub.onVoiceStateUpdate != nil {
		go c.hub.onVoiceStateUpdate(c.userID, data.IsMuted, data.IsDeafened, data.IsStreaming)
	}
}

func (c *Client) handleVoiceAdminStateUpdate(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceAdminStateUpdateData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" {
		dispatchLogger.Warn("voice_admin_state_update missing target_user_id", "user_id", c.userID)
		return
	}

	// Defense-in-depth: reject at the WS layer if the actor isn't allowed
	// to moderate the target. The service callback enforces this too, but
	// failing closed here means a forgotten check in the service can't
	// degrade into a moderation bypass.
	if !c.hub.authorizeVoiceModeration(c.userID, data.TargetUserID, "mute") {
		dispatchLogger.Warn("voice_admin_state_update denied: insufficient perms",
			"actor_id", c.userID, "target_id", data.TargetUserID)
		return
	}

	if c.hub.onVoiceAdminStateUpdate != nil {
		go c.hub.onVoiceAdminStateUpdate(c.userID, data.TargetUserID, data.IsServerMuted, data.IsServerDeafened)
	}
}

func (c *Client) handleVoiceMoveUser(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceMoveUserData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" || data.TargetChannelID == "" {
		dispatchLogger.Warn("voice_move_user missing fields", "user_id", c.userID)
		return
	}

	if !c.hub.authorizeVoiceModeration(c.userID, data.TargetUserID, "move") {
		dispatchLogger.Warn("voice_move_user denied: insufficient perms",
			"actor_id", c.userID, "target_id", data.TargetUserID)
		return
	}

	if c.hub.onVoiceMoveUser != nil {
		go c.hub.onVoiceMoveUser(c.userID, data.TargetUserID, data.TargetChannelID)
	}
}

func (c *Client) handleVoiceDisconnectUser(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data VoiceDisconnectUserData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.TargetUserID == "" {
		dispatchLogger.Warn("voice_disconnect_user missing target_user_id", "user_id", c.userID)
		return
	}

	if !c.hub.authorizeVoiceModeration(c.userID, data.TargetUserID, "disconnect") {
		dispatchLogger.Warn("voice_disconnect_user denied: insufficient perms",
			"actor_id", c.userID, "target_id", data.TargetUserID)
		return
	}

	if c.hub.onVoiceDisconnectUser != nil {
		go c.hub.onVoiceDisconnectUser(c.userID, data.TargetUserID)
	}
}

func (c *Client) handleScreenShareWatch(event Event) {
	dataBytes, err := json.Marshal(event.Data)
	if err != nil {
		return
	}

	var data ScreenShareWatchData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		return
	}

	if data.StreamerUserID == "" {
		dispatchLogger.Warn("screen_share_watch missing streamer_user_id", "user_id", c.userID)
		return
	}

	if c.hub.onScreenShareWatch != nil {
		go c.hub.onScreenShareWatch(c.userID, data.StreamerUserID, data.Watching)
	}
}
