package models

import "time"

// VoiceState is ephemeral — stored in-memory only, not in DB.
// Resets on server restart (all WS connections drop anyway).
type VoiceState struct {
	UserID           string    `json:"user_id"`
	ChannelID        string    `json:"channel_id"`
	ServerID         string    `json:"server_id"` // parent server — used to scope WS broadcasts
	Username         string    `json:"username"`
	DisplayName      string    `json:"display_name"`
	AvatarURL        string    `json:"avatar_url"`
	IsMuted          bool      `json:"is_muted"`
	IsDeafened       bool      `json:"is_deafened"`
	IsStreaming      bool      `json:"is_streaming"`
	IsServerMuted    bool      `json:"is_server_muted"`
	IsServerDeafened bool      `json:"is_server_deafened"`
	LastActivity     time.Time `json:"-"` // not serialized — server-side AFK tracking only

	// Quota-tracking fields. Populated at JoinChannel time so the leave path
	// (explicit leave, AFK kick, orphan cleanup, WS disconnect) can compute
	// the session duration without a second instance lookup, and skip
	// writing usage rows for self-hosted instances. All json:"-" because
	// clients have no business seeing this.
	JoinedAt          time.Time `json:"-"`
	LiveKitInstanceID string    `json:"-"`
	LiveKitIsCloud    bool      `json:"-"` // mirrors instance.IsPlatformManaged at join time
}

type VoiceTokenRequest struct {
	ChannelID string `json:"channel_id"`
}

type VoiceTokenResponse struct {
	Token          string `json:"token"`
	URL            string `json:"url"`
	ChannelID      string `json:"channel_id"`
	E2EEPassphrase string `json:"e2ee_passphrase,omitempty"`
}
