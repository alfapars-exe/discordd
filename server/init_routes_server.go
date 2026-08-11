package main

import "github.com/argeinfina/hichat/models"

// This file holds the SERVER-SCOPED route registrars. They are invoked by
// initRoutes in source order; each keeps its routes in order so the golden
// route-set net (init_routes_test.go) stays green.

func (d *routeDeps) registerServerRoutes() {
	// Server
	d.mux.Handle("GET /api/servers/{serverId}", d.authServer(d.h.Server.GetServer))
	d.mux.Handle("PATCH /api/servers/{serverId}", d.authServerPerm(models.PermAdmin, d.h.Server.UpdateServer))
	d.mux.Handle("DELETE /api/servers/{serverId}", d.authServer(d.h.Server.DeleteServer))
	d.mux.Handle("POST /api/servers/{serverId}/leave", d.authServer(d.h.Server.LeaveServer))
	d.mux.Handle("POST /api/servers/{serverId}/icon", d.authServerPerm(models.PermAdmin, d.h.Avatar.UploadServerIcon))

	// Server Mute
	d.mux.Handle("POST /api/servers/{serverId}/mute", d.authServer(d.h.ServerMute.Mute))
	d.mux.Handle("DELETE /api/servers/{serverId}/mute", d.authServer(d.h.ServerMute.Unmute))

	// Channel Mute
	d.mux.Handle("POST /api/servers/{serverId}/channels/{id}/mute", d.authServer(d.h.ChannelMute.Mute))
	d.mux.Handle("DELETE /api/servers/{serverId}/channels/{id}/mute", d.authServer(d.h.ChannelMute.Unmute))

	// LiveKit settings
	d.mux.Handle("GET /api/servers/{serverId}/livekit", d.authServerPerm(models.PermAdmin, d.h.Server.GetLiveKitSettings))

	// Audit log — moderation history rendered in audit channels. The service
	// itself enforces audit-view perms (Admin or Kick/Ban/Mute/Deafen), so
	// authServer is sufficient here (no per-route perm gate).
	d.mux.Handle("GET /api/servers/{serverId}/audit", d.authServer(d.h.AuditLog.ListServerAudit))
}

func (d *routeDeps) registerChannelRoutes() {
	// Channels
	d.mux.Handle("GET /api/servers/{serverId}/channels", d.authServer(d.h.Channel.List))
	d.mux.Handle("POST /api/servers/{serverId}/channels", d.authServerPerm(models.PermManageChannels, d.h.Channel.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/channels/reorder", d.authServerPerm(models.PermManageChannels, d.h.Channel.Reorder))
	d.mux.Handle("PATCH /api/servers/{serverId}/channels/{id}", d.authServerPerm(models.PermManageChannels, d.h.Channel.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/channels/{id}", d.authServerPerm(models.PermManageChannels, d.h.Channel.Delete))

	// Categories
	d.mux.Handle("GET /api/servers/{serverId}/categories", d.authServer(d.h.Category.List))
	d.mux.Handle("POST /api/servers/{serverId}/categories", d.authServerPerm(models.PermManageChannels, d.h.Category.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/categories/{id}", d.authServerPerm(models.PermManageChannels, d.h.Category.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/categories/{id}", d.authServerPerm(models.PermManageChannels, d.h.Category.Delete))
	d.mux.Handle("PATCH /api/servers/{serverId}/categories/reorder", d.authServerPerm(models.PermManageChannels, d.h.Category.Reorder))
}

func (d *routeDeps) registerMessageRoutes() {
	// Messages
	d.mux.Handle("GET /api/servers/{serverId}/channels/{id}/messages", d.authServer(d.h.Message.List))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{id}/messages", d.authServer(d.h.Message.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/messages/{id}", d.authServer(d.h.Message.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/messages/{id}", d.authServerPermLoad(d.h.Message.Delete))

	// Reactions
	d.mux.Handle("POST /api/servers/{serverId}/messages/{messageId}/reactions", d.authServer(d.h.Reaction.Toggle))

	// Pins
	d.mux.Handle("GET /api/servers/{serverId}/channels/{id}/pins", d.authServer(d.h.Pin.ListPins))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", d.authServerPerm(models.PermManageMessages, d.h.Pin.Pin))
	d.mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", d.authServerPerm(models.PermManageMessages, d.h.Pin.Unpin))

	// Read State — literal "read-all" and "unread" before {id} wildcard
	d.mux.Handle("POST /api/servers/{serverId}/channels/read-all", d.authServer(d.h.ReadState.MarkAllRead))
	d.mux.Handle("GET /api/servers/{serverId}/channels/unread", d.authServer(d.h.ReadState.GetUnreads))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{id}/read", d.authServer(d.h.ReadState.MarkRead))
}

func (d *routeDeps) registerMemberRoutes() {
	// Members
	d.mux.Handle("GET /api/servers/{serverId}/members", d.authServer(d.h.Member.List))
	d.mux.Handle("GET /api/servers/{serverId}/members/{id}", d.authServer(d.h.Member.Get))
	d.mux.Handle("PATCH /api/servers/{serverId}/members/{id}/roles", d.authServerPerm(models.PermManageRoles, d.h.Member.ModifyRoles))
	d.mux.Handle("DELETE /api/servers/{serverId}/members/{id}", d.authServerPerm(models.PermKickMembers, d.h.Member.Kick))
	d.mux.Handle("POST /api/servers/{serverId}/members/{id}/ban", d.authServerPerm(models.PermBanMembers, d.h.Member.Ban))

	// Timeouts — moderator-imposed Discord-style mute. Same route
	// shape as ban (PUT applies, DELETE lifts); permission is a
	// brand-new bit (PermTimeoutMembers) so admins can grant timeout
	// authority without granting full ban authority.
	d.mux.Handle("PUT /api/servers/{serverId}/members/{id}/timeout", d.authServerPerm(models.PermTimeoutMembers, d.h.Member.Timeout))
	d.mux.Handle("DELETE /api/servers/{serverId}/members/{id}/timeout", d.authServerPerm(models.PermTimeoutMembers, d.h.Member.RemoveTimeout))

	// Per-server nickname (migration 065). Authed-only at this layer
	// (any member can hit it) — the handler delegates the self-vs-other
	// permission split to memberService.SetNickname, which checks
	// PermManageNicknames for cross-user renames.
	d.mux.Handle("PATCH /api/servers/{serverId}/members/{id}/nickname", d.authServer(d.h.Member.SetNickname))

	// Bans
	d.mux.Handle("GET /api/servers/{serverId}/bans", d.authServerPerm(models.PermBanMembers, d.h.Member.GetBans))
	d.mux.Handle("DELETE /api/servers/{serverId}/bans/{id}", d.authServerPerm(models.PermBanMembers, d.h.Member.Unban))
}

func (d *routeDeps) registerRoleRoutes() {
	// Roles
	d.mux.Handle("GET /api/servers/{serverId}/roles", d.authServer(d.h.Role.List))
	d.mux.Handle("POST /api/servers/{serverId}/roles", d.authServerPerm(models.PermManageRoles, d.h.Role.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/roles/reorder", d.authServerPerm(models.PermManageRoles, d.h.Role.Reorder))
	d.mux.Handle("PATCH /api/servers/{serverId}/roles/{id}", d.authServerPerm(models.PermManageRoles, d.h.Role.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/roles/{id}", d.authServerPerm(models.PermManageRoles, d.h.Role.Delete))

	// Channel Permissions
	d.mux.Handle("GET /api/servers/{serverId}/channels/{id}/permissions", d.authServer(d.h.ChannelPermission.ListOverrides))
	d.mux.Handle("PUT /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", d.authServerPerm(models.PermManageChannels, d.h.ChannelPermission.SetOverride))
	d.mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", d.authServerPerm(models.PermManageChannels, d.h.ChannelPermission.DeleteOverride))
}

func (d *routeDeps) registerServerMiscRoutes() {
	// Invites
	d.mux.Handle("GET /api/servers/{serverId}/invites", d.authServerPerm(models.PermManageInvites, d.h.Invite.List))
	d.mux.Handle("POST /api/servers/{serverId}/invites", d.authServerPerm(models.PermManageInvites, d.h.Invite.Create))
	d.mux.Handle("DELETE /api/servers/{serverId}/invites/{code}", d.authServerPerm(models.PermManageInvites, d.h.Invite.Delete))

	// E2EE Group Sessions — per-recipient sealed Sender Key envelopes (C-03).
	// No deviceEnum throttle on create/read: the membership + channel-read-
	// permission gate inside authServer/the service is the real access
	// control there.
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/group-sessions", d.authServer(d.h.E2EE.CreateGroupSession))
	d.mux.Handle("GET /api/servers/{serverId}/channels/{channelId}/group-sessions", d.authServer(d.h.E2EE.GetGroupSessions))
	// sender-key-recipients DOES get the deviceEnum throttle (pentest C-03
	// follow-up finding 1): unlike the two routes above, this one hands back
	// prekey/identity-key material for every readable member's every device
	// in one response — exactly the "bulk harvesting of the device-key
	// database" deviceEnum exists to cap, same as the public
	// /api/users/{userId}/devices and /prekey-bundles endpoints.
	d.mux.Handle("GET /api/servers/{serverId}/channels/{channelId}/sender-key-recipients", d.deviceEnum(d.authServer(d.h.E2EE.GetSenderKeyRecipients)))

	// Search
	d.mux.Handle("GET /api/servers/{serverId}/search", d.authServer(d.h.Search.Search))
}

func (d *routeDeps) registerVoiceMusicRoutes() {
	// Voice
	d.mux.Handle("POST /api/servers/{serverId}/voice/token", d.authServer(d.h.Voice.Token))
	d.mux.Handle("POST /api/servers/{serverId}/voice/screen-token", d.authServer(d.h.Voice.ScreenShareToken))
	d.mux.Handle("GET /api/servers/{serverId}/voice/states", d.authServer(d.h.Voice.VoiceStates))

	// Music bot — per-channel YouTube → LiveKit. Permission gating happens
	// inside the handler (PermSpeak for play/skip/pause/resume,
	// PermManageChannels for stop) since this lives "below" the channel.
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/music/play", d.authServer(d.h.Music.Play))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/music/skip", d.authServer(d.h.Music.Skip))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/music/pause", d.authServer(d.h.Music.Pause))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/music/resume", d.authServer(d.h.Music.Resume))
	d.mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/music/stop", d.authServer(d.h.Music.Stop))
	d.mux.Handle("GET /api/servers/{serverId}/channels/{channelId}/music/state", d.authServer(d.h.Music.State))
}

// Soundboard
func (d *routeDeps) registerSoundboardRoutes() {
	d.mux.Handle("GET /api/servers/{serverId}/soundboard/sounds", d.authServer(d.h.Soundboard.List))
	d.mux.Handle("POST /api/servers/{serverId}/soundboard/sounds", d.authServerPerm(models.PermManageSoundboard, d.h.Soundboard.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/soundboard/sounds/{soundId}", d.authServerPerm(models.PermManageSoundboard, d.h.Soundboard.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/soundboard/sounds/{soundId}", d.authServerPerm(models.PermManageSoundboard, d.h.Soundboard.Delete))
	d.mux.Handle("POST /api/servers/{serverId}/soundboard/sounds/{soundId}/play", d.authServerPerm(models.PermUseSoundboard, d.h.Soundboard.Play))
}

func (d *routeDeps) registerWSRoutes() {
	// WebSocket
	d.mux.HandleFunc("GET /ws", d.h.WS.HandleConnection)
	// Read-only bot gateway: authenticates via the Authorization: Bearer hb_…
	// header inside the handler (not the human ticket/JWT path), then streams
	// the BotReadableOps subset scoped to the bot's servers.
	d.mux.HandleFunc("GET /api/bot/gateway", d.h.WS.HandleBotConnection)
}
