package main

import "github.com/argeinfina/hichat/models"

// registerEntranceRoutes wires the voice-channel entrance-sound endpoints.
// /api/users/me/entrance-* act on the caller's own clips and selections —
// every lookup is scoped by user_id inside the service/repository, so plain
// auth is the gate (a server-scoped selection additionally checks
// membership in the service). Server settings and the per-channel switch
// need PermManageSoundboard; muting a member's entrance sound needs
// PermMuteMembers plus the role-hierarchy check in the service. Playback
// has no route: it is triggered server-side by the voice join.
func (d *routeDeps) registerEntranceRoutes() {
	d.mux.Handle("GET /api/users/me/entrance-sounds", d.auth(d.h.Entrance.ListMine))
	d.mux.Handle("POST /api/users/me/entrance-sounds", d.auth(d.h.Entrance.Upload))
	d.mux.Handle("PATCH /api/users/me/entrance-sounds/{soundId}", d.auth(d.h.Entrance.Rename))
	d.mux.Handle("DELETE /api/users/me/entrance-sounds/{soundId}", d.auth(d.h.Entrance.Delete))
	d.mux.Handle("PUT /api/users/me/entrance-selection", d.auth(d.h.Entrance.PutSelection))

	d.mux.Handle("GET /api/servers/{serverId}/entrance-settings", d.authServerPerm(models.PermManageSoundboard, d.h.Entrance.GetSettings))
	d.mux.Handle("PATCH /api/servers/{serverId}/entrance-settings", d.authServerPerm(models.PermManageSoundboard, d.h.Entrance.PatchSettings))
	d.mux.Handle("PUT /api/servers/{serverId}/channels/{channelId}/entrance", d.authServerPerm(models.PermManageSoundboard, d.h.Entrance.SetChannel))
	d.mux.Handle("GET /api/servers/{serverId}/entrance-mutes", d.authServerPerm(models.PermMuteMembers, d.h.Entrance.ListMutes))
	d.mux.Handle("PUT /api/servers/{serverId}/entrance-mutes/{userId}", d.authServerPerm(models.PermMuteMembers, d.h.Entrance.Mute))
	d.mux.Handle("DELETE /api/servers/{serverId}/entrance-mutes/{userId}", d.authServerPerm(models.PermMuteMembers, d.h.Entrance.Unmute))
}
