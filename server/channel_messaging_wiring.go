package main

import (
	"database/sql"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
)

type channelMessagingHub interface {
	ws.BroadcastAndOnline
	SetDurableChannelSends(bool)
}
type channelMessagingServices struct {
	Message       services.MessageRuntime
	Upload        services.UploadService
	Notifications *services.ChannelMessageNotificationWorker
	DeliveryDB    *sql.DB
}

// initChannelMessagingServices binds the message write path and its publication mode.
func initChannelMessagingServices(db *sql.DB, repos *Repositories, hub channelMessagingHub, cfg *config.Config, permissions services.ChannelPermResolver, audit services.AuditWriter) channelMessagingServices {
	if repos == nil {
		panic("channel messaging requires repositories")
	}
	if cfg == nil {
		panic("channel messaging requires config")
	}
	if missingCompositionInput(hub) {
		panic("channel messaging requires hub")
	}
	if missingCompositionInput(permissions) {
		panic("channel messaging requires permissions")
	}
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Message", repos.Message}, {"Attachment", repos.Attachment}, {"Channel", repos.Channel}, {"User", repos.User},
		{"Mention", repos.Mention}, {"RoleMention", repos.RoleMention}, {"Role", repos.Role}, {"Reaction", repos.Reaction},
		{"ReadState", repos.ReadState}, {"MemberTimeout", repos.MemberTimeout}, {"Notification", repos.Notification}, {"Preferences", repos.Preferences},
	} {
		if missingCompositionInput(input.value) {
			panic("channel messaging requires repository " + input.name)
		}
	}
	var deliveryDB *sql.DB
	if database.IsPostgres(db) {
		deliveryDB = db
	}
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.RoleMention, repos.Role, repos.Reaction, repos.ReadState,
		repos.MemberTimeout, repository.NewMessageTxRunner(db), hub, permissions, audit,
		repos.Notification, deliveryDB,
	)
	channelMessageNotificationWorker := services.NewChannelMessageNotificationWorker(
		repository.NewSQLiteChannelMessageNotificationQueue(db), repos.Preferences, repos.User, hub, database.IsPostgres(db),
	)
	messageService.SetUploadDir(cfg.Upload.Dir)
	if database.IsPostgres(db) {
		hub.SetDurableChannelSends(true)
	}
	uploadService := services.NewUploadService(repos.Attachment, cfg.Upload.Dir, cfg.Upload.MaxSize)
	return channelMessagingServices{Message: messageService, Upload: uploadService, Notifications: channelMessageNotificationWorker, DeliveryDB: deliveryDB}
}

// Interface-typed dependencies can hold nil pointers at a composition boundary.
func missingCompositionInput(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
