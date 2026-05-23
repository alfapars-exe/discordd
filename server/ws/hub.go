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
	"log"
	"sync"
	"sync/atomic"
)

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
}

func NewHub() *Hub {
	return &Hub{
		clients:        make(map[string]map[*Client]bool),
		serverClients:  make(map[string]map[*Client]bool),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
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

// Shutdown closes all client connections (graceful shutdown).
func (h *Hub) Shutdown() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, clients := range h.clients {
		for client := range clients {
			close(client.send)
		}
	}
	h.clients = make(map[string]map[*Client]bool)
	h.serverClients = make(map[string]map[*Client]bool)
	log.Println("[ws] hub shut down, all connections closed")
}
