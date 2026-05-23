package ws

// ─── Interface Segregation ───
//
// Hub capabilities split into focused interfaces (ISP):
// - Broadcaster: event publishing (used by most services)
// - UserStateProvider: online user queries (message, p2p_call)
// - ClientManager: connection management (server, member)
//
// Composed interfaces:
// - BroadcastAndOnline = Broadcaster + UserStateProvider
// - BroadcastAndManage = Broadcaster + ClientManager
// - EventPublisher = all three (ws package + main wire-up)

// Broadcaster publishes events over WebSocket.
type Broadcaster interface {
	BroadcastToAll(event Event)
	BroadcastToAllExcept(excludeUserID string, event Event)
	BroadcastToUser(userID string, event Event)
	BroadcastToUsers(userIDs []string, event Event)
	BroadcastToServer(serverID string, event Event)
	BroadcastToServerExcept(serverID, excludeUserID string, event Event)
}

// UserStateProvider queries connected user state.
type UserStateProvider interface {
	GetOnlineUserIDs() []string
	GetVisibleOnlineUserIDs() []string
	GetOnlineUserIDsForServer(serverID string) []string
}

// ClientManager manages WebSocket client connections.
type ClientManager interface {
	SetInvisible(userID string, invisible bool)
	DisconnectUser(userID string)
	AddClientServerID(userID, serverID string)
	RemoveClientServerID(userID, serverID string)
}

// BroadcastAndOnline — used by MessageService, P2PCallService.
type BroadcastAndOnline interface {
	Broadcaster
	UserStateProvider
}

// BroadcastAndManage — used by ServerService, MemberService.
type BroadcastAndManage interface {
	Broadcaster
	ClientManager
}

// EventPublisher is the full Hub interface. Used in ws package and main wire-up.
type EventPublisher interface {
	Broadcaster
	UserStateProvider
	ClientManager
}
