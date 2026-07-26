package main

import "net/http"

// This file holds the GLOBAL (server-independent) route registrars. They are
// invoked by initRoutes in source order; each keeps its routes in order so the
// golden route-set net (init_routes_test.go) stays green.

// Auth
func (d *routeDeps) registerAuthRoutes() {
	d.mux.HandleFunc("POST /api/auth/register", d.h.Auth.Register)
	d.mux.HandleFunc("POST /api/auth/login", d.h.Auth.Login)
	d.mux.HandleFunc("POST /api/auth/refresh", d.h.Auth.Refresh)
	d.mux.Handle("POST /api/auth/logout", d.auth(d.h.Auth.Logout))
	d.mux.HandleFunc("POST /api/auth/forgot-password", d.h.Auth.ForgotPassword)
	d.mux.HandleFunc("POST /api/auth/reset-password", d.h.Auth.ResetPassword)
	d.mux.Handle("POST /api/auth/ws-ticket", d.auth(d.h.Auth.WSTicket))
}

// User
func (d *routeDeps) registerUserRoutes() {
	d.mux.Handle("GET /api/users/me", d.auth(d.h.Auth.Me))
	d.mux.Handle("PATCH /api/users/me/profile", d.auth(d.h.Member.UpdateProfile))
	d.mux.Handle("POST /api/users/me/password", d.auth(d.h.Auth.ChangePassword))
	d.mux.Handle("PUT /api/users/me/email", d.auth(d.h.Auth.ChangeEmail))
	d.mux.Handle("POST /api/users/me/avatar", d.auth(d.h.Avatar.UploadUserAvatar))
	d.mux.Handle("POST /api/users/me/wallpaper", d.auth(d.h.Avatar.UploadUserWallpaper))
	d.mux.Handle("DELETE /api/users/me/wallpaper", d.auth(d.h.Avatar.DeleteUserWallpaper))
	d.mux.Handle("GET /api/users/me/preferences", d.auth(d.h.Preferences.Get))
	d.mux.Handle("POST /api/users/me/dismiss-download-prompt", d.auth(d.h.DownloadPrompt.Dismiss))
	d.mux.Handle("POST /api/users/me/dismiss-welcome", d.auth(d.h.DownloadPrompt.DismissWelcome))
	d.mux.Handle("PATCH /api/users/me/preferences", d.auth(d.h.Preferences.Update))
}

// Servers
func (d *routeDeps) registerServerListRoutes() {
	d.mux.Handle("GET /api/servers", d.auth(d.h.Server.ListMyServers))
	d.mux.Handle("POST /api/servers", d.auth(d.h.Server.CreateServer))
	d.mux.Handle("POST /api/servers/join", d.auth(d.h.Server.JoinServer))
	d.mux.Handle("PATCH /api/servers/reorder", d.auth(d.h.Server.ReorderServers))

	// Server mutes — literal path before {serverId} wildcard
	d.mux.Handle("GET /api/servers/mutes", d.auth(d.h.ServerMute.ListMuted))
}

func (d *routeDeps) registerUploadRoutes() {
	// Standalone POST /api/upload was removed: it allowed any authenticated
	// user to attach a file to any message_id (no ownership / channel-access
	// check), trusting "random ID is unguessable" as a security boundary.
	// All real upload paths go through the message-create endpoints (channel
	// or DM), where the transaction binds the file to a message the caller
	// just authored, and no client ever invoked the standalone form.

	// Upload download — attachments are access-controlled, the rest is public.
	//
	// F-1 (audit 2026-05-29): the earlier A4 auth boundary had been reverted to
	// a fully-public serve because a native `<img>` can't carry a Bearer header.
	// It's now restored via the "dedicated HttpOnly image-auth cookie" approach
	// that was flagged as the proper fix: Serve authenticates channel/DM
	// attachments with the hichat_media cookie (set on login/refresh) OR a
	// Bearer header, while avatars/server icons/badges/soundboard stay public so
	// they keep rendering in unauthenticated `<img>` contexts.
	//
	// Deliberately NOT behind auth middleware — Serve does its own cookie/Bearer
	// extraction so the public categories don't 401. Path traversal is rejected
	// in Serve and again in serveFile (path.Clean + SafeJoin).
	d.mux.Handle("GET /api/uploads/", http.HandlerFunc(d.h.UploadDownload.Serve))
}

func (d *routeDeps) registerDMRoutes() {
	// DMs — literal paths before parametric
	d.mux.Handle("GET /api/dms/settings", d.auth(d.h.DMSettings.GetSettings))
	d.mux.Handle("GET /api/dms", d.auth(d.h.DM.ListChannels))
	d.mux.Handle("POST /api/dms", d.auth(d.h.DM.CreateOrGetChannel))

	// DM Settings — /api/dms/channels/ prefix avoids route ambiguity with /api/dms/{channelId}
	d.mux.Handle("POST /api/dms/channels/{channelId}/hide", d.auth(d.h.DMSettings.HideDM))
	d.mux.Handle("DELETE /api/dms/channels/{channelId}/hide", d.auth(d.h.DMSettings.UnhideDM))
	d.mux.Handle("POST /api/dms/channels/{channelId}/pin-conversation", d.auth(d.h.DMSettings.PinConversation))
	d.mux.Handle("DELETE /api/dms/channels/{channelId}/pin-conversation", d.auth(d.h.DMSettings.UnpinConversation))
	d.mux.Handle("POST /api/dms/channels/{channelId}/mute", d.auth(d.h.DMSettings.MuteDM))
	d.mux.Handle("DELETE /api/dms/channels/{channelId}/mute", d.auth(d.h.DMSettings.UnmuteDM))

	// DM Request accept/decline
	d.mux.Handle("POST /api/dms/channels/{channelId}/accept", d.auth(d.h.DM.AcceptRequest))
	d.mux.Handle("POST /api/dms/channels/{channelId}/decline", d.auth(d.h.DM.DeclineRequest))

	// DM Messages
	d.mux.Handle("GET /api/dms/{channelId}/messages", d.auth(d.h.DM.GetMessages))
	d.mux.Handle("POST /api/dms/{channelId}/messages", d.auth(d.h.DM.SendMessage))
	d.mux.Handle("PATCH /api/dms/messages/{id}", d.auth(d.h.DM.EditMessage))
	d.mux.Handle("DELETE /api/dms/messages/{id}", d.auth(d.h.DM.DeleteMessage))
	d.mux.Handle("POST /api/dms/messages/{id}/reactions", d.auth(d.h.DM.ToggleReaction))
	d.mux.Handle("POST /api/dms/messages/{id}/pin", d.auth(d.h.DM.PinMessage))
	d.mux.Handle("DELETE /api/dms/messages/{id}/pin", d.auth(d.h.DM.UnpinMessage))
	d.mux.Handle("GET /api/dms/{channelId}/pinned", d.auth(d.h.DM.GetPinnedMessages))
	d.mux.Handle("GET /api/dms/{channelId}/search", d.auth(d.h.DM.SearchMessages))
	d.mux.Handle("PATCH /api/dms/channels/{channelId}/e2ee", d.auth(d.h.DM.ToggleE2EE))
}

func (d *routeDeps) registerBlockReportRoutes() {
	// Block — literal "blocked" before parametric {userId}
	d.mux.Handle("GET /api/users/blocked", d.auth(d.h.Block.ListBlocked))
	d.mux.Handle("POST /api/users/{userId}/block", d.auth(d.h.Block.BlockUser))
	d.mux.Handle("DELETE /api/users/{userId}/block", d.auth(d.h.Block.UnblockUser))

	// Report
	d.mux.Handle("POST /api/users/{userId}/report", d.auth(d.h.Report.CreateReport))
}

func (d *routeDeps) registerDiagnosticsRoutes() {
	// Client diagnostic logs (screen-share lifecycle, Electron crash dumps, etc.)
	d.mux.Handle("POST /api/client-log", d.auth(d.h.ClientLog.Log))
	// Diagnostics report — emails the gzipped bundle to the admin via SMTP.
	d.mux.Handle("POST /api/diagnostics-report", d.auth(d.h.Diagnostics.Report))
}

// Feedback
func (d *routeDeps) registerFeedbackRoutes() {
	d.mux.Handle("POST /api/feedback", d.auth(d.h.Feedback.CreateTicket))
	d.mux.Handle("GET /api/feedback", d.auth(d.h.Feedback.ListMyTickets))
	d.mux.Handle("GET /api/feedback/{id}", d.auth(d.h.Feedback.GetTicket))
	d.mux.Handle("POST /api/feedback/{id}/reply", d.auth(d.h.Feedback.AddReply))
	d.mux.Handle("DELETE /api/feedback/{id}", d.auth(d.h.Feedback.DeleteTicket))
}

func (d *routeDeps) registerE2EERoutes() {
	// E2EE Devices
	d.mux.Handle("GET /api/devices", d.auth(d.h.Device.List))
	d.mux.Handle("POST /api/devices", d.auth(d.h.Device.Register))
	d.mux.Handle("DELETE /api/devices/{deviceId}", d.auth(d.h.Device.Delete))
	d.mux.Handle("POST /api/devices/{deviceId}/prekeys", d.auth(d.h.Device.UploadPrekeys))
	d.mux.Handle("PUT /api/devices/{deviceId}/signed-prekey", d.auth(d.h.Device.UpdateSignedPrekey))
	d.mux.Handle("GET /api/devices/{deviceId}/prekey-count", d.auth(d.h.Device.GetPrekeyCount))

	// E2EE Key Backup
	d.mux.Handle("PUT /api/e2ee/key-backup", d.auth(d.h.E2EE.UpsertKeyBackup))
	d.mux.Handle("GET /api/e2ee/key-backup", d.auth(d.h.E2EE.GetKeyBackup))
	d.mux.Handle("DELETE /api/e2ee/key-backup", d.auth(d.h.E2EE.DeleteKeyBackup))

	// E2EE User Devices / Prekey Bundles
	d.mux.Handle("GET /api/users/{userId}/devices", d.deviceEnum(d.auth(d.h.Device.ListPublicDevices)))
	d.mux.Handle("GET /api/users/{userId}/prekey-bundles", d.deviceEnum(d.auth(d.h.Device.GetPrekeyBundles)))
}

func (d *routeDeps) registerMiscGlobalRoutes() {
	// Channel mutes — literal path before {serverId} wildcard
	d.mux.Handle("GET /api/channels/mutes", d.auth(d.h.ChannelMute.ListMuted))

	// Link Preview
	d.mux.Handle("GET /api/link-preview", d.auth(d.h.LinkPreview.Get))
}

// Badges — literal paths before parametric
func (d *routeDeps) registerBadgeRoutes() {
	d.mux.Handle("GET /api/badges", d.auth(d.h.Badge.ListBadges))
	d.mux.Handle("POST /api/badges", d.auth(d.h.Badge.CreateBadge))
	d.mux.Handle("POST /api/badges/icon", d.auth(d.h.Badge.UploadBadgeIcon))
	d.mux.Handle("PATCH /api/badges/{id}", d.auth(d.h.Badge.UpdateBadge))
	d.mux.Handle("DELETE /api/badges/{id}", d.auth(d.h.Badge.DeleteBadge))
	d.mux.Handle("POST /api/badges/{id}/assign", d.auth(d.h.Badge.AssignBadge))
	d.mux.Handle("DELETE /api/badges/{id}/assign/{userId}", d.auth(d.h.Badge.UnassignBadge))
	d.mux.Handle("GET /api/users/{userId}/badges", d.auth(d.h.Badge.GetUserBadges))
}

// GIFs (Klipy proxy)
func (d *routeDeps) registerGifRoutes() {
	d.mux.Handle("GET /api/gifs/trending", d.auth(d.h.Gif.Trending))
	d.mux.Handle("GET /api/gifs/search", d.auth(d.h.Gif.Search))
}

// Friends
func (d *routeDeps) registerFriendRoutes() {
	d.mux.Handle("GET /api/friends/requests", d.auth(d.h.Friendship.ListRequests))
	d.mux.Handle("POST /api/friends/requests", d.auth(d.h.Friendship.SendRequest))
	d.mux.Handle("POST /api/friends/requests/{id}/accept", d.auth(d.h.Friendship.AcceptRequest))
	d.mux.Handle("DELETE /api/friends/requests/{id}", d.auth(d.h.Friendship.DeclineRequest))
	d.mux.Handle("GET /api/friends", d.auth(d.h.Friendship.ListFriends))
	d.mux.Handle("DELETE /api/friends/{userId}", d.auth(d.h.Friendship.RemoveFriend))
}

// Bots — owner-facing automation account management. The same botService
// that backs bot-token validation in the auth middleware also serves the
// management handler. The Create guard rejects bot callers (a bot can't
// mint bots); list/revoke are scoped to the caller inside the service.
func (d *routeDeps) registerBotRoutes() {
	d.mux.Handle("POST /api/bots", d.auth(d.botHandler.Create))
	d.mux.Handle("GET /api/bots", d.auth(d.botHandler.List))
	d.mux.Handle("POST /api/bots/{botID}/revoke", d.auth(d.botHandler.Revoke))
}

func (d *routeDeps) registerAdminRoutes() {
	// Platform Admin — LiveKit
	d.mux.Handle("GET /api/admin/livekit/quota", d.authAdmin(d.h.Admin.GetLiveKitQuotaReport))
	d.mux.Handle("GET /api/admin/livekit-instances", d.authAdmin(d.h.Admin.ListLiveKitInstances))
	d.mux.Handle("GET /api/admin/livekit-instances/{id}/metrics/timeseries", d.authAdmin(d.h.Admin.GetLiveKitInstanceMetricsTimeSeries))
	d.mux.Handle("GET /api/admin/livekit-instances/{id}/metrics/history", d.authAdmin(d.h.Admin.GetLiveKitInstanceMetricsHistory))
	d.mux.Handle("GET /api/admin/livekit-instances/{id}/metrics", d.authAdmin(d.h.Admin.GetLiveKitInstanceMetrics))
	d.mux.Handle("PATCH /api/admin/livekit-instances/{id}/quota", d.authAdmin(d.h.Admin.UpdateLiveKitQuotaSettings))
	d.mux.Handle("GET /api/admin/livekit-instances/{id}", d.authAdmin(d.h.Admin.GetLiveKitInstance))
	d.mux.Handle("POST /api/admin/livekit-instances", d.authAdmin(d.h.Admin.CreateLiveKitInstance))
	d.mux.Handle("PATCH /api/admin/livekit-instances/{id}", d.authAdmin(d.h.Admin.UpdateLiveKitInstance))
	d.mux.Handle("DELETE /api/admin/livekit-instances/{id}", d.authAdmin(d.h.Admin.DeleteLiveKitInstance))

	// Platform Admin — Servers
	d.mux.Handle("GET /api/admin/servers", d.authAdmin(d.h.Admin.ListServers))
	d.mux.Handle("PATCH /api/admin/servers/{serverId}/instance", d.authAdmin(d.h.Admin.MigrateServerInstance))
	d.mux.Handle("DELETE /api/admin/servers/{serverId}", d.authAdmin(d.h.Admin.AdminDeleteServer))

	// Platform Admin — Reports
	d.mux.Handle("GET /api/admin/reports", d.authAdmin(d.h.Admin.ListReports))
	d.mux.Handle("PATCH /api/admin/reports/{id}/status", d.authAdmin(d.h.Admin.UpdateReportStatus))

	// Platform Admin — Feedback
	d.mux.Handle("GET /api/admin/feedback", d.authAdmin(d.h.Feedback.AdminListTickets))
	d.mux.Handle("GET /api/admin/feedback/{id}", d.authAdmin(d.h.Feedback.AdminGetTicket))
	d.mux.Handle("POST /api/admin/feedback/{id}/reply", d.authAdmin(d.h.Feedback.AdminReply))
	d.mux.Handle("PATCH /api/admin/feedback/{id}/status", d.authAdmin(d.h.Feedback.AdminUpdateStatus))

	// Platform Admin — Users
	d.mux.Handle("GET /api/admin/users", d.authAdmin(d.h.Admin.ListUsers))
	d.mux.Handle("POST /api/admin/users/{id}/ban", d.authAdmin(d.h.Admin.PlatformBanUser))
	d.mux.Handle("DELETE /api/admin/users/{id}/ban", d.authAdmin(d.h.Admin.PlatformUnbanUser))
	d.mux.Handle("DELETE /api/admin/users/{id}", d.authAdmin(d.h.Admin.HardDeleteUser))
	d.mux.Handle("PATCH /api/admin/users/{id}/platform-admin", d.authAdmin(d.h.Admin.SetUserPlatformAdmin))

	// Platform Admin — App Logs
	d.mux.Handle("GET /api/admin/logs", d.authAdmin(d.h.Admin.ListAppLogs))
	d.mux.Handle("DELETE /api/admin/logs", d.authAdmin(d.h.Admin.ClearAppLogs))
}

func (d *routeDeps) registerPublicRoutes() {
	// LiveKit Webhook — no auth middleware, verified via HMAC signature
	d.mux.HandleFunc("POST /api/livekit/webhook", d.h.LiveKitWebhook.HandleWebhook)

	// Stats — public
	d.mux.HandleFunc("GET /api/stats", d.h.Stats.GetPublicStats)

	// Invite Preview — public (no auth)
	d.mux.HandleFunc("GET /api/invites/{code}/preview", d.h.Invite.Preview)
}
