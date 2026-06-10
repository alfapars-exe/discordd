package testutil

import (
	"github.com/argeinfina/hichat/ws"
)

// ─── WS mock (Broadcaster, EventPublisher) ───

type MockBroadcaster struct {
	BroadcastToAllFn          func(event ws.Event)
	BroadcastToAllExceptFn    func(excludeUserID string, event ws.Event)
	BroadcastToUserFn         func(userID string, event ws.Event)
	BroadcastToUsersFn        func(userIDs []string, event ws.Event)
	BroadcastToServerFn       func(serverID string, event ws.Event)
	BroadcastToServerExceptFn func(serverID, excludeUserID string, event ws.Event)
}

func (m *MockBroadcaster) BroadcastToAll(event ws.Event) {
	if m.BroadcastToAllFn != nil {
		m.BroadcastToAllFn(event)
	}
}
func (m *MockBroadcaster) BroadcastToAllExcept(excludeUserID string, event ws.Event) {
	if m.BroadcastToAllExceptFn != nil {
		m.BroadcastToAllExceptFn(excludeUserID, event)
	}
}
func (m *MockBroadcaster) BroadcastToUser(userID string, event ws.Event) {
	if m.BroadcastToUserFn != nil {
		m.BroadcastToUserFn(userID, event)
	}
}
func (m *MockBroadcaster) BroadcastToUsers(userIDs []string, event ws.Event) {
	if m.BroadcastToUsersFn != nil {
		m.BroadcastToUsersFn(userIDs, event)
	}
}
func (m *MockBroadcaster) BroadcastToServer(serverID string, event ws.Event) {
	if m.BroadcastToServerFn != nil {
		m.BroadcastToServerFn(serverID, event)
	}
}
func (m *MockBroadcaster) BroadcastToServerExcept(serverID, excludeUserID string, event ws.Event) {
	if m.BroadcastToServerExceptFn != nil {
		m.BroadcastToServerExceptFn(serverID, excludeUserID, event)
	}
}

// MockEventPublisher satisfies ws.EventPublisher (Broadcaster + UserStateProvider + ClientManager).
type MockEventPublisher struct {
	MockBroadcaster
	GetOnlineUserIDsFn          func() []string
	GetVisibleOnlineUserIDsFn   func() []string
	GetOnlineUserIDsForServerFn func(serverID string) []string
	SetInvisibleFn              func(userID string, invisible bool)
	DisconnectUserFn            func(userID string)
	AddClientServerIDFn         func(userID, serverID string)
	RemoveClientServerIDFn      func(userID, serverID string)
	UpdateUserInfoFn            func(userID, username, displayName, avatarURL string)
}

func (m *MockEventPublisher) GetOnlineUserIDs() []string {
	if m.GetOnlineUserIDsFn != nil {
		return m.GetOnlineUserIDsFn()
	}
	return nil
}
func (m *MockEventPublisher) GetVisibleOnlineUserIDs() []string {
	if m.GetVisibleOnlineUserIDsFn != nil {
		return m.GetVisibleOnlineUserIDsFn()
	}
	return nil
}
func (m *MockEventPublisher) GetOnlineUserIDsForServer(serverID string) []string {
	if m.GetOnlineUserIDsForServerFn != nil {
		return m.GetOnlineUserIDsForServerFn(serverID)
	}
	return nil
}
func (m *MockEventPublisher) SetInvisible(userID string, invisible bool) {
	if m.SetInvisibleFn != nil {
		m.SetInvisibleFn(userID, invisible)
	}
}
func (m *MockEventPublisher) DisconnectUser(userID string) {
	if m.DisconnectUserFn != nil {
		m.DisconnectUserFn(userID)
	}
}
func (m *MockEventPublisher) AddClientServerID(userID, serverID string) {
	if m.AddClientServerIDFn != nil {
		m.AddClientServerIDFn(userID, serverID)
	}
}
func (m *MockEventPublisher) RemoveClientServerID(userID, serverID string) {
	if m.RemoveClientServerIDFn != nil {
		m.RemoveClientServerIDFn(userID, serverID)
	}
}
func (m *MockEventPublisher) UpdateUserInfo(userID, username, displayName, avatarURL string) {
	if m.UpdateUserInfoFn != nil {
		m.UpdateUserInfoFn(userID, username, displayName, avatarURL)
	}
}

// ─── MockBroadcastAndOnline satisfies ws.BroadcastAndOnline ───

type MockBroadcastAndOnline struct {
	MockBroadcaster
	GetOnlineUserIDsFn          func() []string
	GetVisibleOnlineUserIDsFn   func() []string
	GetOnlineUserIDsForServerFn func(serverID string) []string
}

func (m *MockBroadcastAndOnline) GetOnlineUserIDs() []string {
	if m.GetOnlineUserIDsFn != nil {
		return m.GetOnlineUserIDsFn()
	}
	return nil
}
func (m *MockBroadcastAndOnline) GetVisibleOnlineUserIDs() []string {
	if m.GetVisibleOnlineUserIDsFn != nil {
		return m.GetVisibleOnlineUserIDsFn()
	}
	return nil
}
func (m *MockBroadcastAndOnline) GetOnlineUserIDsForServer(serverID string) []string {
	if m.GetOnlineUserIDsForServerFn != nil {
		return m.GetOnlineUserIDsForServerFn(serverID)
	}
	return nil
}
