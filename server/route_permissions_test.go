package main

// route_permissions_test.go — P1.9: every route initRoutes registers must
// carry a declared authorization gate. "Declared" means one of two things:
//
//   - A gatedHandler produced by one of routeDeps' chain helpers (auth,
//     authServer, authServerPerm, authServerPermLoad, authAdmin, refresh) —
//     recovered here via the same gateOf helper init_routes.go uses.
//   - An explicit, reasoned entry in noRouteLevelGate (registered via
//     mux.HandleFunc, or mux.Handle with a raw handler) for the small set of
//     routes that are genuinely public or do their own auth inside the
//     handler (documented at each registration site in init_routes_*.go).
//
// A route using authServer alone (authenticated + server member, but no
// specific permission bit) is a real, common, and often-correct pattern —
// most GET/list endpoints only need membership. But it's also exactly the
// shape a route needing an actual permission check would have if that
// check were simply forgotten at the route layer. So every authServer-only
// route must additionally have an entry in handlerInternalGates explaining
// why membership alone is the intended gate, or citing where the real
// check happens (inside the handler or service). A new authServer-only
// route with no table entry fails this test until someone makes that call
// deliberately, instead of it slipping through as="probably fine".
//
// Does NOT parse openapi.yaml (gopkg.in/yaml.v3 is an indirect dependency
// only — adding it as a direct import here would be a new dependency for a
// test, out of scope). This test derives everything from what initRoutes
// itself registers.

import (
	"net/http"
	"testing"
)

// gateRecordingRegistrar captures each registered pattern and, when the
// handler is a gatedHandler, the routeGate that produced it.
type gateRecordingRegistrar struct {
	patterns []string
	gates    map[string]routeGate
}

func newGateRecordingRegistrar() *gateRecordingRegistrar {
	return &gateRecordingRegistrar{gates: make(map[string]routeGate)}
}

func (r *gateRecordingRegistrar) Handle(pattern string, handler http.Handler) {
	r.patterns = append(r.patterns, pattern)
	if gate, ok := gateOf(handler); ok {
		r.gates[pattern] = gate
	}
}

func (r *gateRecordingRegistrar) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	// mux.HandleFunc always bypasses every chain helper (they all return
	// http.Handler via gatedHandler, never a bare func) — no gate to record.
	// That absence IS the declaration: "this route is intentionally public
	// or self-authenticating", checked against noRouteLevelGate below.
	r.patterns = append(r.patterns, pattern)
}

// noRouteLevelGate lists every route registered with no gatedHandler at
// all — via mux.HandleFunc, or (GET /api/uploads/) mux.Handle with a raw
// http.Handler. Each entry's reason is a pointer to where the route does
// its own auth, or why it's genuinely public; see the registration site in
// init_routes_global.go / init_routes_server.go for the full rationale.
var noRouteLevelGate = map[string]string{
	"POST /api/auth/register":         "public signup — no account exists yet to authenticate",
	"POST /api/auth/login":            "public login — no account exists yet to authenticate",
	"POST /api/auth/forgot-password":  "public — initiates a reset flow via emailed token, not JWT auth",
	"POST /api/auth/reset-password":   "public — authorizes via the emailed reset token itself, not JWT auth",
	"POST /api/livekit/webhook":       "authenticated by LiveKit's own webhook signature, not user auth",
	"GET /api/stats":                  "explicitly public platform stats endpoint",
	"GET /api/invites/{code}/preview": "public invite preview (social/crawler OG embeds)",
	"GET /ws":                         "authenticates via a short-lived WS ticket inside the handler (ws/handler.go), not the HTTP auth middleware",
	"GET /api/bot/gateway":            "authenticates via Authorization: Bearer hb_… bot token inside the handler (ws/bot_gateway.go), not the human auth middleware",
	"GET /api/uploads/":               "does its own cookie/Bearer auth per-category inside UploadDownloadHandler.Serve (init_routes_global.go's registerUploadRoutes doc comment, F-1 2026-05-29) — avatars/icons/badges/soundboard stay public for <img> tags; channel/DM attachments authenticate via the hichat_media cookie or a Bearer header",
}

// handlerInternalGates lists every authServer-only route (membership, no
// authServerPerm bit) and why that's the intended access control: either
// "membership is genuinely sufficient" (most GET/list endpoints, and a few
// self-scoped writes like leave/mute-preferences/read-state), or a pointer
// to the handler/service code that enforces a permission or ownership check
// that route-level authServerPerm can't express (a single server-wide
// permission bit doesn't fit a check that's actually per-channel, or an
// ownership comparison that isn't a role permission at all).
var handlerInternalGates = map[string]string{
	// ── Server ──
	"GET /api/servers/{serverId}":        "read-only — membership is the intended view gate",
	"DELETE /api/servers/{serverId}":     "ownership check inside the service: services/server_service_crud.go DeleteServer requires server.OwnerID == userID (server ownership isn't modeled as a role permission)",
	"POST /api/servers/{serverId}/leave": "self-scoped — any member may leave their own membership",

	// ── Server / channel mute (personal notification preference) ──
	"POST /api/servers/{serverId}/mute":                 "self-scoped notification preference, not a moderation action",
	"DELETE /api/servers/{serverId}/mute":               "self-scoped notification preference, not a moderation action",
	"POST /api/servers/{serverId}/channels/{id}/mute":   "self-scoped notification preference, not a moderation action",
	"DELETE /api/servers/{serverId}/channels/{id}/mute": "self-scoped notification preference, not a moderation action",

	// ── Audit ──
	"GET /api/servers/{serverId}/audit": "service enforces audit-view perms (PermAdmin or Kick/Ban/Mute/Deafen) — see init_routes_server.go:28-30's doc comment",

	// ── Channels / categories (read) ──
	"GET /api/servers/{serverId}/channels":   "read-only — membership is the intended view gate (per-channel visibility filter applied inside channelService.GetAllGrouped)",
	"GET /api/servers/{serverId}/categories": "read-only — membership is the intended view gate",

	// ── Messages / reactions / pins — per-channel, not server-wide ──
	"GET /api/servers/{serverId}/channels/{id}/messages":          "per-channel PermViewChannel+PermReadMessages enforced inside messageService — can't be one server-wide authServerPerm bit",
	"POST /api/servers/{serverId}/channels/{id}/messages":         "per-channel PermSendMessages enforced inside messageService",
	"PATCH /api/servers/{serverId}/messages/{id}":                 "author-ownership (or moderator override) enforced inside messageService.Update, evaluated per-message",
	"POST /api/servers/{serverId}/messages/{messageId}/reactions": "per-channel permission enforced inside reactionService",
	"GET /api/servers/{serverId}/channels/{id}/pins":              "per-channel read permission enforced inside pinService",

	// ── Read state (self-scoped) ──
	"POST /api/servers/{serverId}/channels/read-all":  "self-scoped — marks the caller's own read state",
	"GET /api/servers/{serverId}/channels/unread":     "self-scoped — reads the caller's own read state",
	"POST /api/servers/{serverId}/channels/{id}/read": "self-scoped — marks the caller's own read state",

	// ── Members (read) ──
	"GET /api/servers/{serverId}/members":                 "read-only — membership is the intended view gate",
	"GET /api/servers/{serverId}/members/{id}":            "read-only — membership is the intended view gate",
	"PATCH /api/servers/{serverId}/members/{id}/nickname": "self-vs-other split enforced inside memberService.SetNickname (PermManageNicknames required only for renaming someone else) — see init_routes_server.go:86-89's doc comment",

	// ── Roles / channel permissions (read) ──
	"GET /api/servers/{serverId}/roles":                     "read-only — membership is the intended view gate",
	"GET /api/servers/{serverId}/channels/{id}/permissions": "read-only — membership is the intended view gate (override metadata, not sensitive)",

	// ── E2EE group sessions — per-channel read/send permission ──
	"POST /api/servers/{serverId}/channels/{channelId}/group-sessions":       "membership + per-channel permission gate — see init_routes_server.go:117-120's doc comment",
	"GET /api/servers/{serverId}/channels/{channelId}/group-sessions":        "membership + per-channel permission gate — see init_routes_server.go:117-120's doc comment",
	"GET /api/servers/{serverId}/channels/{channelId}/sender-key-recipients": "membership + per-channel permission gate, plus a deviceEnum throttle (pentest C-03 follow-up) — see init_routes_server.go:123-128's doc comment",

	// ── Search — scoped per-channel, not server-wide (H-05) ──
	"GET /api/servers/{serverId}/search": "results scoped per-channel via channelPermService inside searchService (H-05) — can't be one server-wide authServerPerm bit",

	// ── Voice — per-channel connect permission ──
	"POST /api/servers/{serverId}/voice/token":        "per-channel PermConnectVoice enforced inside voiceService.GenerateToken",
	"POST /api/servers/{serverId}/voice/screen-token": "per-channel permission enforced inside voiceService.GenerateScreenShareToken",
	"GET /api/servers/{serverId}/voice/states":        "read-only — membership is the intended view gate",

	// ── Music bot — PermSpeak/PermManageChannels enforced in the handler ──
	"POST /api/servers/{serverId}/channels/{channelId}/music/play":   "PermSpeak enforced inside the handler — handlers/music.go:89 (requirePerm at :181)",
	"POST /api/servers/{serverId}/channels/{channelId}/music/skip":   "PermSpeak enforced inside the handler — handlers/music.go:119",
	"POST /api/servers/{serverId}/channels/{channelId}/music/pause":  "PermSpeak enforced inside the handler — handlers/music.go:124",
	"POST /api/servers/{serverId}/channels/{channelId}/music/resume": "PermSpeak enforced inside the handler — handlers/music.go:129",
	"POST /api/servers/{serverId}/channels/{channelId}/music/stop":   "PermManageChannels enforced inside the handler — handlers/music.go:135",
	"GET /api/servers/{serverId}/channels/{channelId}/music/state":   "read-only — membership is the intended view gate",

	// ── Soundboard (read) ──
	"GET /api/servers/{serverId}/soundboard/sounds": "read-only — membership is the intended view gate",
}

// TestRoutePermissions_EveryRouteHasADeclaredGate is this file's core
// assertion (see the top doc comment for the full rule).
//
// Non-vacuity check performed by hand while authoring this test: removing
// one handlerInternalGates entry (e.g. the music/play line) turns this test
// red for that route; removing one noRouteLevelGate entry (e.g. "GET /ws")
// also turns it red. Restoring either turns the test green again.
func TestRoutePermissions_EveryRouteHasADeclaredGate(t *testing.T) {
	rec := newGateRecordingRegistrar()
	initRoutes(rec, &Handlers{}, nil, nil, nil, nil, nil, nil, nil)

	seen := make(map[string]bool, len(rec.patterns))
	for _, pattern := range rec.patterns {
		if seen[pattern] {
			continue // duplicates are TestInitRoutesNoDuplicates' job, not this test's
		}
		seen[pattern] = true

		gate, hasGate := rec.gates[pattern]
		if !hasGate {
			if reason, ok := noRouteLevelGate[pattern]; !ok || reason == "" {
				t.Errorf("%s: registered with no declared gate (not a gatedHandler) and no noRouteLevelGate entry — "+
					"wrap it with one of routeDeps' chain helpers (auth/authServer/authServerPerm/authServerPermLoad/authAdmin), "+
					"or add a reasoned noRouteLevelGate entry if it's genuinely public/self-authenticating", pattern)
			}
			continue
		}

		if gate.kind != "authServer" {
			continue // authServerPerm/authAdmin/auth/authServerPermLoad/refresh all declare their own gate explicitly
		}
		if reason, ok := handlerInternalGates[pattern]; !ok || reason == "" {
			t.Errorf("%s: authServer-only route (membership, no specific permission) with no handlerInternalGates entry — "+
				"either gate it with authServerPerm, or document why membership alone (or an internal check) is the intended access control", pattern)
		}
	}

	// Catch stale entries too: a table entry for a route that no longer
	// exists (renamed/removed) is a silent gap waiting for its replacement
	// route to slip through ungated.
	for pattern := range noRouteLevelGate {
		if !seen[pattern] {
			t.Errorf("noRouteLevelGate has a stale entry for %q — route no longer registered by initRoutes", pattern)
		}
	}
	for pattern := range handlerInternalGates {
		if !seen[pattern] {
			t.Errorf("handlerInternalGates has a stale entry for %q — route no longer registered by initRoutes", pattern)
		}
	}
}
