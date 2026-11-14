package main

import "github.com/argeinfina/hichat/services"

type personalMessagingDependencies struct {
	Repositories *Repositories
	Permissions  services.ChannelPermResolver
}
type personalMessagingServices struct {
	Saved           services.SavedService
	Reminder        services.ReminderService
	UserNote        services.UserNoteService
	Personalization services.PersonalizationService
}

// initPersonalMessagingServices shares the channel read resolver between saved
// messages and reminders; DM access continues to use membership repositories.
// Reminder worker startup remains separately owned by the process lifecycle.
func initPersonalMessagingServices(deps personalMessagingDependencies) personalMessagingServices {
	repos := deps.Repositories
	return personalMessagingServices{
		Saved:           services.NewSavedService(repos.Saved, repos.Message, repos.Channel, repos.DM, deps.Permissions),
		Reminder:        services.NewReminderService(repos.Reminder, repos.Message, repos.Channel, repos.DM, deps.Permissions),
		UserNote:        services.NewUserNoteService(repos.UserNote, repos.User),
		Personalization: services.NewPersonalizationService(repos.Preferences, repos.User, repos.Server, repos.Friendship),
	}
}
