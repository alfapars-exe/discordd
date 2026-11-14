package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type channelNavigationPermissions interface {
	services.ChannelPermResolver
	services.ChannelVisibilityChecker
	services.ChannelPermissionMapper
}
type channelNavigationDependencies struct {
	Repositories     *Repositories
	Hub              ws.BroadcastAndOnline
	Permissions      channelNavigationPermissions
	FreshPermissions services.FreshChannelPermResolver
	VoiceDeletion    services.VoiceChannelDeletionHandler
	Audit            services.AuditWriter
	UploadDir        string
}
type channelNavigationServices struct {
	Channel   services.ChannelService
	Thread    services.ThreadService
	Category  services.CategoryService
	Pin       services.PinService
	Search    services.SearchService
	ReadState services.ReadStateService
}

// initChannelNavigationServices shares channel visibility/read providers while
// keeping fresh publication authorization an explicit separate dependency.
func initChannelNavigationServices(deps channelNavigationDependencies) channelNavigationServices {
	repos := deps.Repositories
	channel := services.NewChannelService(deps.VoiceDeletion, repos.Channel, repos.Category, deps.Hub, deps.Permissions, deps.Audit, repos.Notification, deps.FreshPermissions)
	channel.SetUploadDir(deps.UploadDir)
	return channelNavigationServices{
		Channel:  channel,
		Thread:   services.NewThreadService(repos.Channel, repos.Message, deps.Permissions, deps.Hub, deps.FreshPermissions),
		Category: services.NewCategoryService(repos.Category, deps.Hub),
		Pin:      services.NewPinService(repos.Pin, repos.Message, repos.Channel, deps.Hub, deps.Permissions),
		// Search receives both channel enumeration and effective read permission maps.
		Search:    services.NewSearchService(repos.Search, repos.Channel, deps.Permissions),
		ReadState: services.NewReadStateService(repos.ReadState, deps.Permissions),
	}
}
