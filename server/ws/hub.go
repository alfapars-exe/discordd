// Package ws — WebSocket hub + client handler.
//
// Hub is the central pub-sub for every WS message the server emits.
// Originally a single 791-line god class; the implementation is now
// split by concern into sibling files (all in the same `ws` package
// so the methods stay attached to *Hub):
//
//	hub.go             — this file: struct, NewHub, Run loop, Shutdown,
//	                     cachedUserInfo helper struct.
//	hub_interfaces.go  — ISP interfaces (Broadcaster, UserStateProvider,
//	                     ClientManager + composed flavours) the service
//	                     layer depends on.
//	hub_callbacks.go   — 13+ callback type definitions and the On*
//	                     registration methods called from main.go.
//	hub_clients.go     — connection lifecycle: addClient / removeClient,
//	                     the serverClients index, DisconnectUser,
//	                     SetInvisible, AddClientServerID, etc.
//	hub_broadcast.go   — every BroadcastTo* method (To All / User /
//	                     Users / Server / *Except variants).
//	hub_state.go       — GetOnlineUserIDsFor*, presence aggregation,
//	                     userInfos cache accessors, statusPriority table.
//
// Locking discipline: h.mu (sync.RWMutex) protects clients + serverClients
// + invisibleUsers — single lock, no nested ordering. h.userMu is a
// separate RWMutex for userInfos to keep that hot read path off the main
// lock during typing/voice broadcasts.
package ws

import (
	"sync"
	"sync/atomic"

	"github.com/argeinfina/hichat/pkg/logx"
)

// hubLogger tags every Hub-lifecycle log line ("ws.hub"). Shared
// package-level var — also used from hub_clients.go and hub_broadcast.go.
var hubLogger = logx.Component("ws.hub")

// cachedUserInfo holds user info cached at WS connect time.
// Avoids DB lookups for typing/voice broadcasts.
type cachedUserInfo struct {
	Username    string
	DisplayName string
	AvatarURL   string
}

// Hub manages all WebSocket connections (Observer pattern).
// A single goroutine processes register/unregister via channels.
type Hub struct {
	// clients: userID -> set of Client connections (multi-tab support)
	clients map[string]map[*Client]bool

	// serverClients: serverID -> set of Client connections for that server's members.
	// Maintained in sync with client.serverIDs and h.clients.
	// Enables O(server_size) BroadcastToServer instead of O(total_clients).
	// Protected by mu (same lock as clients).
	serverClients map[string]map[*Client]bool

	mu sync.RWMutex

	register   chan *Client
	unregister chan *Client

	// seq: monotonic counter for outbound event ordering
	seq atomic.Int64

	// userInfos: cached user info for typing/voice broadcasts
	userInfos map[string]cachedUserInfo
	userMu    sync.RWMutex

	// invisibleUsers: users with "offline" (invisible) status who are still connected.
	// Protected by mu (same lock as clients).
	invisibleUsers map[string]bool

	// Presence callbacks — set in main.go.
	// Called in separate goroutines to avoid deadlock (callback may call Broadcast
	// which needs RLock, but add/removeClient holds Lock).
	onUserFirstConnect      UserConnectionCallback
	onUserFullyDisconnected UserConnectionCallback

	// Voice callbacks — set in main.go
	onVoiceJoin             VoiceJoinCallback
	onVoiceLeave            VoiceLeaveCallback
	onVoiceStateUpdate      VoiceStateUpdateCallback
	onVoiceAdminStateUpdate VoiceAdminStateUpdateCallback
	onVoiceMoveUser         VoiceMoveUserCallback
	onVoiceDisconnectUser   VoiceDisconnectUserCallback
	onVoiceActivity         VoiceActivityCallback

	onPresenceManualUpdate PresenceManualUpdateCallback

	// P2P Call callbacks — set in main.go
	onP2PCallInitiate P2PCallInitiateCallback
	onP2PCallAccept   P2PCallAcceptCallback
	onP2PCallDecline  P2PCallDeclineCallback
	onP2PCallEnd      P2PCallEndCallback
	onP2PSignal       P2PSignalCallback

	// Channel typing callback — set in main.go
	onChannelTyping ChannelTypingCallback

	// DM callbacks — set in main.go
	onDMTyping DMTypingCallback

	// Screen share viewer tracking — set in main.go
	onScreenShareWatch ScreenShareWatchCallback

	// Structured app logger — set in main.go
	appLogger AppLogger

	// Defense-in-depth check for voice moderation events delivered over WS.
	// Nil-safe — when absent, legacy single-layer behaviour applies. Set in main.go.
	voiceAdminAuthz VoiceAdminAuthorizer

	// ─── Runtime op counters (P3.10) — surfaced via Stats() into
	// startRuntimeStatsLogger's periodic slog line, not exposed as an HTTP
	// endpoint. atomic.Uint64 rather than h.mu: these are incremented from
	// per-connection read-pump goroutines on every inbound event, so gating
	// them behind the same lock that guards the clients map would add
	// contention to the hottest path in the hub for a metric nobody reads
	// per-request.
	dispatchCount  atomic.Uint64 // successfully routed to a registered handler (client_dispatch.go)
	rateLimitDrops atomic.Uint64 // dropped by the per-(client,op) rate limiter (client_dispatch.go)
	queueDrops     atomic.Uint64 // queueUnregister's buffer-full default branch, below
}

func NewHub() *Hub {
	return &Hub{
		clients:       make(map[string]map[*Client]bool),
		serverClients: make(map[string]map[*Client]bool),
		register:      make(chan *Client, 64),
		// Buffered unregister channel: broadcast paths that detect a slow
		// client spawn a goroutine to push onto this channel. If the Run
		// loop is momentarily busy processing other registers, the buffer
		// lets those goroutines complete and exit instead of piling up
		// blocked on a synchronous send. 256 is enough headroom for a
		// thundering-herd disconnect (server restart, network blip) and
		// still bounded so it can't grow without limit.
		unregister:     make(chan *Client, 256),
		userInfos:      make(map[string]cachedUserInfo),
		invisibleUsers: make(map[string]bool),
	}
}

// Run is the Hub's main event loop. Started as `go hub.Run()` in main.go.
// The register / unregister channels serialize connection state changes
// through this single goroutine — callers never touch h.clients directly.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.addClient(client)

		case client := <-h.unregister:
			h.removeClient(client)
		}
	}
}

// queueUnregister enqueues a slow client for disconnection without
// blocking the caller. Used by every broadcast path that detects a full
// send buffer — we want broadcasts to make forward progress instead of
// stalling on a synchronous unregister handoff. The buffered channel
// (NewHub) provides headroom; this select-default protects against the
// pathological case where the buffer is also full (which can only happen
// if hundreds of clients fail send simultaneously and the Run loop is
// momentarily blocked). In that case we drop the duplicate enqueue —
// the read-pump will hit its error and unregister itself on its own
// goroutine soon enough.
func (h *Hub) queueUnregister(c *Client) {
	select {
	case h.unregister <- c:
	default:
		// Buffer full; client will be unregistered via its read-pump exit.
		h.queueDrops.Add(1)
	}
}

// HubStats is a point-in-time snapshot of the Hub's runtime op counters, for
// startRuntimeStatsLogger's periodic log line (see Stats).
type HubStats struct {
	DispatchCount        uint64
	RateLimitDrops       uint64
	QueueUnregisterDrops uint64
	// QueueUnregisterLen is the current unregister channel backlog, not a
	// cumulative counter — a sustained non-zero value means the Run loop
	// (hub.go's single register/unregister goroutine) is falling behind.
	QueueUnregisterLen int
}

// Stats returns a snapshot of the hub's runtime op counters. Safe to call
// from any goroutine; len(h.unregister) races with concurrent sends/receives
// by definition (channel len is inherently a snapshot), which is exactly
// the "how full is it right now" signal the caller wants.
func (h *Hub) Stats() HubStats {
	return HubStats{
		DispatchCount:        h.dispatchCount.Load(),
		RateLimitDrops:       h.rateLimitDrops.Load(),
		QueueUnregisterDrops: h.queueDrops.Load(),
		QueueUnregisterLen:   len(h.unregister),
	}
}

// Shutdown closes all client connections (graceful shutdown).
//
// Two-phase close (audit 2026-05-27):
//  1. client.closeDone() — closes the done channel; WritePump exits via its
//     `<-c.done` path after flushing any buffered send. send is never closed
//     (see Client.done) so in-flight sendEvent writes can't panic.
//  2. client.conn.Close() — unblocks ReadPump's blocking ReadMessage() so
//     it exits in microseconds instead of waiting up to pongWait (90s) for
//     the read deadline to fire.
//
// Without phase 2, a SIGTERM with 10k+ open connections would wait the
// full read-deadline window before all goroutines exited — well past most
// orchestrator graceful-shutdown grace periods (Docker default 10s,
// Kubernetes terminationGracePeriodSeconds default 30s). conn.Close on an
// already-closed conn is a no-op for gorilla/websocket (returns error but
// doesn't panic), so this is safe even if a client just disconnected.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	clientList := make([]*Client, 0)
	for _, clients := range h.clients {
		for client := range clients {
			clientList = append(clientList, client)
		}
	}
	h.clients = make(map[string]map[*Client]bool)
	h.serverClients = make(map[string]map[*Client]bool)
	h.mu.Unlock()

	// Close outside the mutex to avoid holding it for 10k iterations.
	// closeDone fans out to WritePump, conn.Close fans out to ReadPump —
	// both run concurrently per client and unblock instantly.
	for _, client := range clientList {
		client.closeDone()
		// Not deferred — this is a loop over up to 10k+ connections; a
		// defer here would pin every connection's handle open until
		// Shutdown itself returns instead of closing each one as we go.
		_ = client.conn.Close() // already-closed is acceptable
	}
	hubLogger.Info("hub shut down", "connections_closed", len(clientList))
}
