package main

import (
	"database/sql"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type socialMessagingDependencies struct {
	Database      *sql.DB
	DeliveryDB    *sql.DB
	Repositories  *Repositories
	Hub           ws.Broadcaster
	Config        *config.Config
	Activity      services.GameActivityPrivacyInvalidator
	Privacy       privacyPolicies
	Email         services.ScheduledEmailEnqueuer
	EncryptionKey []byte
}

type socialMessagingServices struct {
	Block         services.BlockService
	DMSettings    services.DMSettingsService
	Notification  services.NotificationRuntime
	Emoji         services.EmojiService
	DM            services.DMRuntime
	Friendship    services.FriendshipService
	GroupDM       services.GroupDMService
	DMUpload      services.DMUploadRuntime
	GroupDMUpload services.GroupDMUploadService
}

// initSocialMessagingServices binds relationship writers and private messaging.
// The graph reader breaks the construction cycle: friendship auto-accept uses
// the same DM owner returned to HTTP and the separately started workers.
func initSocialMessagingServices(deps socialMessagingDependencies) socialMessagingServices {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Database", deps.Database}, {"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Config", deps.Config}, {"Activity", deps.Activity},
	} {
		if missingCompositionInput(input.value) {
			panic("social messaging requires " + input.name)
		}
	}
	for _, input := range []struct {
		name  string
		value any
	}{
		{"ServerDM", deps.Privacy.ServerDM}, {"FriendRequests", deps.Privacy.FriendRequests}, {"FriendGraph", deps.Privacy.FriendGraph.reader},
	} {
		if missingCompositionInput(input.value) {
			panic("social messaging requires policy " + input.name)
		}
	}
	// A nil email provider disables email; typed nil cannot safely do so.
	if deps.Email != nil && missingCompositionInput(deps.Email) {
		panic("social messaging email provider is typed nil")
	}
	repos, cfg := deps.Repositories, deps.Config
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Friendship", repos.Friendship}, {"User", repos.User}, {"DMSettings", repos.DMSettings}, {"DM", repos.DM},
		{"Notification", repos.Notification}, {"Emoji", repos.Emoji}, {"Server", repos.Server}, {"DMRead", repos.DMRead},
		{"Preferences", repos.Preferences}, {"GroupDM", repos.GroupDM},
	} {
		if missingCompositionInput(input.value) {
			panic("social messaging requires repository " + input.name)
		}
	}
	block := services.NewBlockService(deps.Activity, repos.Friendship, repos.User, deps.Hub)
	settings := services.NewDMSettingsService(repos.DMSettings, repos.DM, deps.Hub)
	notifications := services.NewNotificationService(repos.Notification, deps.Hub)
	emoji := services.NewEmojiService(repos.Emoji, repos.Server, deps.Hub, cfg.Upload.Dir)
	dm := services.NewDMService(deps.Privacy.ServerDM,
		repos.DM, repos.User, deps.Hub, block, deps.Privacy.FriendGraph, settings,
		repos.DMRead, repos.Notification, repository.NewDMMessageTxRunner(deps.Database),
		deps.Email, repos.Preferences, repos.Notification, emoji, deps.DeliveryDB)
	friendship := services.NewFriendshipService(deps.Activity, repos.Friendship, repos.User,
		repos.Notification, deps.Hub, deps.Email, dm, deps.Privacy.FriendRequests)
	group := services.NewGroupDMService(repos.GroupDM, repos.User, repos.Friendship, deps.Hub,
		cfg.LiveKit.URL, cfg.LiveKit.APIKey, cfg.LiveKit.APISecret, deps.EncryptionKey,
		cfg.Upload.Dir, repos.Notification, repos.Preferences, block, repos.GroupDM)
	dm.SetUploadDir(cfg.Upload.Dir)
	return socialMessagingServices{
		Block: block, DMSettings: settings, Notification: notifications, Emoji: emoji,
		DM: dm, Friendship: friendship, GroupDM: group,
		DMUpload:      services.NewDMUploadService(repos.DM, cfg.Upload.Dir, cfg.Upload.MaxSize),
		GroupDMUpload: services.NewGroupDMUploadService(repos.GroupDM, cfg.Upload.Dir, cfg.Upload.MaxSize),
	}
}
