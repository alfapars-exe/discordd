package main

import (
	"context"
	"database/sql"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type moderationMessages interface {
	GetAround(context.Context, string, string, string, string, int) (*models.MessagePage, error)
}
type moderationDMs interface {
	GetMessagesAround(context.Context, string, string, string, int) (*models.DMMessagePage, error)
}
type moderationDependencies struct {
	Database      *sql.DB
	Repositories  *Repositories
	Hub           ws.BroadcastAndOnline
	Permissions   services.ChannelPermResolver
	Messages      moderationMessages
	DMs           moderationDMs
	Emoji         services.EmojiResolver
	UploadDir     string
	MaxUploadSize int64
}
type moderationServices struct {
	SpamInbox    *services.SpamInboxService
	MediaLabel   *services.MediaLabelService
	Reaction     services.ReactionService
	Report       services.ReportService
	ReportUpload services.ReportUploadService
}

// initModerationServices keeps report evidence behind the same channel/DM
// readers used by ordinary requests, and shares the spam inbox with labels.
func initModerationServices(deps moderationDependencies) moderationServices {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Database", deps.Database}, {"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Permissions", deps.Permissions}, {"Messages", deps.Messages}, {"DMs", deps.DMs}, {"Emoji", deps.Emoji},
	} {
		if missingCompositionInput(input.value) {
			panic("moderation requires " + input.name)
		}
	}
	repos := deps.Repositories
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Message", repos.Message}, {"Channel", repos.Channel}, {"DM", repos.DM}, {"GroupDM", repos.GroupDM}, {"Reaction", repos.Reaction},
		{"MemberTimeout", repos.MemberTimeout}, {"Notification", repos.Notification}, {"Preferences", repos.Preferences}, {"User", repos.User}, {"Report", repos.Report},
	} {
		if missingCompositionInput(input.value) {
			panic("moderation requires repository " + input.name)
		}
	}
	spam := services.NewSpamInboxService(repository.NewSpamInboxRepository(deps.Database), repos.Message, repos.Channel, repos.DM, repos.GroupDM, deps.Permissions, deps.Hub)
	labels := services.NewMediaLabelService(repository.NewMediaLabelRepository(deps.Database), spam, deps.Hub)
	reaction := services.NewReactionService(repos.Reaction, repos.Message, repos.Channel, deps.Hub, deps.Permissions, repos.MemberTimeout,
		services.ReactionNotificationDependencies{Notifications: repos.Notification, Preferences: repos.Preferences, Users: repos.User}, deps.Emoji)
	return moderationServices{
		SpamInbox: spam, MediaLabel: labels, Reaction: reaction,
		Report:       services.NewReportService(repos.Report, repos.User, deps.Messages, deps.DMs, repos.GroupDM),
		ReportUpload: services.NewReportUploadService(repos.Report, deps.UploadDir, deps.MaxUploadSize),
	}
}
