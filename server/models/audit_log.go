package models

import "time"

// AuditEventType enumerates the moderation/admin events recorded in the
// audit_logs table. Strings are stable identifiers — the client maps each
// to a localized i18n template at render time, so renaming any value here
// is a breaking change for the audit-channel UI.
type AuditEventType string

const (
	// ── Moderation (voice) ──
	AuditEventServerMute     AuditEventType = "server_mute"
	AuditEventServerUnmute   AuditEventType = "server_unmute"
	AuditEventServerDeafen   AuditEventType = "server_deafen"
	AuditEventServerUndeafen AuditEventType = "server_undeafen"
	AuditEventVoiceKick      AuditEventType = "voice_kick" // AdminDisconnect
	AuditEventVoiceMove      AuditEventType = "voice_move" // metadata: from_channel, to_channel

	// ── Membership ──
	AuditEventMemberJoin          AuditEventType = "member_join"
	AuditEventMemberLeave         AuditEventType = "member_leave"
	AuditEventMemberKick          AuditEventType = "member_kick"
	AuditEventMemberBan           AuditEventType = "member_ban"          // metadata: reason, expires_at (optional)
	AuditEventMemberUnban         AuditEventType = "member_unban"
	AuditEventMemberTimeout        AuditEventType = "member_timeout"          // metadata: reason, expires_at
	AuditEventMemberTimeoutRemove  AuditEventType = "member_timeout_remove"
	AuditEventMemberNicknameChange AuditEventType = "member_nickname_change"  // metadata: nickname (omitted = cleared)

	// ── Roles ──
	AuditEventRoleCreate AuditEventType = "role_create"
	AuditEventRoleDelete AuditEventType = "role_delete"
	AuditEventRoleAssign AuditEventType = "role_assign" // metadata: role_name
	AuditEventRoleRemove AuditEventType = "role_remove" // metadata: role_name

	// ── Channels ──
	AuditEventChannelCreate AuditEventType = "channel_create" // metadata: channel_name, channel_type
	AuditEventChannelDelete AuditEventType = "channel_delete" // metadata: channel_name
	AuditEventChannelRename AuditEventType = "channel_rename" // metadata: old_name, new_name

	// ── Message moderation ──
	// Only emitted when a moderator (not the author) deletes a message.
	// metadata: channel_name, content_preview (optional)
	AuditEventMessageDelete AuditEventType = "message_delete"
)

// UserSnapshot is a frozen-in-time copy of the user fields needed to render
// an audit entry. Stored as JSON in audit_logs.actor_snapshot /
// target_snapshot so the entry stays human-readable even if the user later
// changes their display name or is deleted.
type UserSnapshot struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
}

// AuditLog is one row of the audit_logs table — a single moderation event.
type AuditLog struct {
	ID             string         `json:"id"`
	ServerID       string         `json:"server_id"`
	ActorUserID    *string        `json:"actor_user_id"`
	TargetUserID   *string        `json:"target_user_id"`
	EventType      AuditEventType `json:"event_type"`
	Metadata       string         `json:"metadata"`         // raw JSON
	ActorSnapshot  *UserSnapshot  `json:"actor,omitempty"`  // unmarshalled at read time
	TargetSnapshot *UserSnapshot  `json:"target,omitempty"` // unmarshalled at read time
	CreatedAt      time.Time      `json:"created_at"`
}

// AuditLogFilter parameters for paginated list queries.
//
// Pagination is keyset on (created_at, id). BeforeID (the id of the last row
// the client already has) is the preferred cursor: the repo looks that row's
// created_at up server-side and pages on the (created_at, id) pair, so a page
// boundary that lands among rows sharing a created_at (two moderation actions
// in the same second) no longer skips or repeats entries. Before (a raw
// created_at) is the legacy cursor an older client may still send; when only
// Before is set the repo falls back to the created_at-only comparison (the
// edge-case-prone behaviour), so upgrading the server never breaks it.
type AuditLogFilter struct {
	ServerID string
	Before   *time.Time // legacy cursor — created_at of the last row (fallback)
	BeforeID *string    // preferred cursor — id of the last row the client has
	Limit    int
}
