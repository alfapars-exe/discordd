package main

import (
	"context"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type gameActivityCallbackRegistrar interface {
	OnGameActivityConnect(ws.GameActivityConnectionCallback)
	OnGameActivityUpdate(ws.GameActivityUpdateCallback)
	OnGameActivityDisconnect(ws.GameActivityConnectionCallback)
	OnGameActivitySnapshot(ws.GameActivitySnapshotCallback)
	OnGameActivityPresenceChange(ws.GameActivitySnapshotCallback)
}

type gameActivityCallbackRuntime interface {
	Start()
	Stop()
	Connect(string, uint64)
	Update(context.Context, string, uint64, uint64, *ws.GameActivityClientGame)
	Disconnect(context.Context, string, uint64)
	Snapshot(context.Context, string)
	PolicyChanged(context.Context, string)
}

// A nil runtime disables all registrations and returns a no-op cleanup.
// Production checks its optional concrete service before crossing this boundary.
func registerGameActivityCallbacks(hub gameActivityCallbackRegistrar, gameActivity gameActivityCallbackRuntime) func() {
	if gameActivity == nil {
		return func() {}
	}
	gameActivity.Start()
	hub.OnGameActivityConnect(func(userID string, connectionID uint64) {
		gameActivity.Connect(userID, connectionID)
	})
	hub.OnGameActivityUpdate(func(userID string, connectionID, sequence uint64, game *ws.GameActivityClientGame) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()
		gameActivity.Update(ctx, userID, connectionID, sequence, game)
	})
	hub.OnGameActivityDisconnect(func(userID string, connectionID uint64) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()
		gameActivity.Disconnect(ctx, userID, connectionID)
	})
	hub.OnGameActivitySnapshot(func(userID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()
		gameActivity.Snapshot(ctx, userID)
	})
	hub.OnGameActivityPresenceChange(func(userID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()
		gameActivity.PolicyChanged(ctx, userID)
	})
	return gameActivity.Stop
}
