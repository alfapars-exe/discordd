package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type presenceNotificationDependencies struct {
	Repositories *Repositories
	Hub          ws.BroadcastAndOnline
}
type presenceNotificationServices struct {
	ProfileUpdates services.ProfileUpdateNotifier
	OnlineFriends  services.OnlineFriendNotifierRuntime
}

// initPresenceNotificationServices shares profile/friend privacy readers and
// notification writers. The returned online owner must be stopped by the caller.
func initPresenceNotificationServices(deps presenceNotificationDependencies) presenceNotificationServices {
	repos := deps.Repositories
	profile := services.NewProfileUpdateNotifier(repos.Preferences, repos.Friendship, repos.Notification, deps.Hub)
	online := services.NewOnlineFriendNotifier(repos.User, repos.Preferences, repos.Friendship, repos.Notification, deps.Hub, deps.Hub, repos.Notification)
	return presenceNotificationServices{ProfileUpdates: profile, OnlineFriends: online}
}
