package main

import (
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// Handlers holds all HTTP handler instances.
type Handlers struct {
	GameJoin              *handlers.GameJoinHandler
	AccountStatus         *handlers.AccountStatusHandler
	AccountDeletionStatus *handlers.AccountDeletionStatusHandler
	EmailVerification     *handlers.EmailVerificationHandler
	EmailUnsubscribe      *handlers.EmailUnsubscribeHandler
	EmailCampaign         *handlers.EmailCampaignHandler
	Auth                  *handlers.AuthHandler
	Channel               *handlers.ChannelHandler
	Thread                *handlers.ThreadHandler
	Category              *handlers.CategoryHandler
	Message               *handlers.MessageHandler
	Member                *handlers.MemberHandler
	Role                  *handlers.RoleHandler
	Voice                 *handlers.VoiceHandler
	Server                *handlers.ServerHandler
	Invite                *handlers.InviteHandler
	Pin                   *handlers.PinHandler
	Search                *handlers.SearchHandler
	ReadState             *handlers.ReadStateHandler
	DM                    *handlers.DMHandler
	GroupDM               *handlers.GroupDMHandler
	Reaction              *handlers.ReactionHandler
	ChannelPermission     *handlers.ChannelPermissionHandler
	Friendship            *handlers.FriendshipHandler
	Avatar                *handlers.AvatarHandler
	Stats                 *handlers.StatsHandler
	Admin                 *handlers.AdminHandler
	ServerMute            *handlers.ServerMuteHandler
	ChannelMute           *handlers.ChannelMuteHandler
	DMSettings            *handlers.DMSettingsHandler
	Block                 *handlers.BlockHandler
	Report                *handlers.ReportHandler
	Gif                   *handlers.GifHandler
	Device                *handlers.DeviceHandler
	E2EE                  *handlers.E2EEHandler
	LinkPreview           *handlers.LinkPreviewHandler
	Badge                 *handlers.BadgeHandler
	Preferences           *handlers.PreferencesHandler
	DownloadPrompt        *handlers.DownloadPromptHandler
	Feedback              *handlers.FeedbackHandler
	Diagnostics           *handlers.DiagnosticsHandler
	AuditLog              *handlers.AuditLogHandler
	Soundboard            *handlers.SoundboardHandler
	Emoji                 *handlers.EmojiHandler
	Sticker               *handlers.StickerHandler
	Entrance              *handlers.EntranceHandler
	Cosmetic              *handlers.CosmeticHandler
	ExpressionClone       *handlers.ExpressionCloneHandler
	Music                 *handlers.MusicHandler
	LiveKitWebhook        *handlers.LiveKitWebhookHandler
	ClientLog             *handlers.ClientLogHandler
	UploadDownload        *handlers.UploadDownloadHandler
	Notification          *handlers.NotificationHandler
	Reminder              *handlers.ReminderHandler
	Saved                 *handlers.SavedHandler
	SpamInbox             *handlers.SpamInboxHandler
	MediaLabel            *handlers.MediaLabelHandler
	UserNote              *handlers.UserNoteHandler
	DataExport            *handlers.DataExportHandler
	Personalization       *handlers.PersonalizationHandler
	ClipRecording         *handlers.ClipRecordingHandler
	ProfileShowcase       *handlers.ProfileShowcaseHandler
	ServerEvent           *handlers.ServerEventHandler
	WS                    *ws.Handler
}

func initHandlers(svcs *Services, repos *Repositories, limiters *RateLimiters, hub *ws.Hub, cfg *config.Config, encryptionKey []byte, botService *services.BotService) *Handlers {
	authHandler := handlers.NewAuthHandler(svcs.Auth, svcs.WSTicket, limiters.Login, limiters.Register, limiters.ForgotPwd, limiters.ResetPwd, limiters.WSTicket)
	authHandler.SetMFAService(svcs.MFA)
	voiceStateFilter := services.NewVoiceStateVisibilityFilter(svcs.ChannelPermission, repos.Channel, repos.Server)
	liveKitWebhook := handlers.NewLiveKitWebhookHandler(repos.LiveKit, encryptionKey, svcs.AppLog, svcs.Voice, repos.LiveKit)
	verifier, ok := any(svcs.Voice).(services.CurrentScreenShareVerifier)
	if !ok || repos.StreamStartNotification == nil || hub == nil {
		panic("stream start notification dependencies are not wired")
	}
	liveKitWebhook.SetStreamStartNotifier(services.NewStreamStartNotifier(repos.StreamStartNotification, verifier, hub))
	musicAccess := handlers.MusicAccessDependencies{Channels: repos.Channel, Voice: svcs.Voice, Members: repos.Server}
	musicAccess.Sessions, _ = svcs.Auth.(handlers.MusicSessionValidator)
	if musicAccess.Sessions == nil {
		panic("music session validation dependency is not wired")
	}
	return &Handlers{
		GameJoin:              handlers.NewGameJoinHandler(svcs.GameJoin, svcs.Auth, repos.User, repos.AccountLifecycle),
		AccountStatus:         handlers.NewAccountStatusHandler(repos.AccountStatus),
		AccountDeletionStatus: handlers.NewAccountDeletionStatusHandler(repos.AccountDeletionStatus),
		EmailVerification:     handlers.NewEmailVerificationHandler(svcs.EmailVerification, limiters.VerifyEmail),
		EmailUnsubscribe:      handlers.NewEmailUnsubscribeHandler(repos.EmailUnsubscribe, limiters.EmailUnsubscribe),
		EmailCampaign:         handlers.NewEmailCampaignHandler(svcs.EmailCampaign),
		Auth:                  authHandler,
		Channel:               handlers.NewChannelHandler(svcs.Channel),
		Thread:                handlers.NewThreadHandler(svcs.Thread),
		Category:              handlers.NewCategoryHandler(svcs.Category),
		Message:               handlers.NewMessageHandler(svcs.Message, svcs.Upload, cfg.Upload.MaxSize, limiters.Message, limiters.Upload),
		Member:                handlers.NewMemberHandler(svcs.Member, svcs.ProfileAudience),
		Role:                  handlers.NewRoleHandler(svcs.Role),
		Voice:                 handlers.NewVoiceHandler(svcs.Voice, voiceStateFilter),
		Server:                handlers.NewServerHandler(svcs.Server),
		Invite:                handlers.NewInviteHandler(svcs.Invite),
		Pin:                   handlers.NewPinHandler(svcs.Pin),
		Search:                handlers.NewSearchHandler(svcs.Search),
		ReadState:             handlers.NewReadStateHandler(svcs.ReadState),
		DM:                    handlers.NewDMHandler(svcs.DM, svcs.DMUpload, cfg.Upload.MaxSize, limiters.DMMessage, limiters.Upload),
		GroupDM:               handlers.NewGroupDMHandler(svcs.GroupDM, svcs.GroupDMUpload, cfg.Upload.MaxSize, limiters.DMMessage, limiters.SocialAction, limiters.Upload),
		Reaction:              handlers.NewReactionHandler(svcs.Reaction),
		ChannelPermission:     handlers.NewChannelPermissionHandler(svcs.ChannelPermission),
		Friendship:            handlers.NewFriendshipHandler(svcs.Friendship, limiters.SocialAction),
		Avatar:                handlers.NewAvatarHandler(repos.User, svcs.Member, svcs.Server, cfg.Upload.Dir, limiters.Upload),
		Stats:                 handlers.NewStatsHandler(repos.User),
		Admin:                 handlers.NewAdminHandler(svcs.LiveKitAdmin, svcs.MetricsHistory, svcs.AdminUser, svcs.AdminServer, svcs.Report, svcs.AppLog, svcs.Voice),
		ServerMute:            handlers.NewServerMuteHandler(svcs.ServerMute),
		ChannelMute:           handlers.NewChannelMuteHandler(svcs.ChannelMute),
		DMSettings:            handlers.NewDMSettingsHandler(svcs.DMSettings),
		Block:                 handlers.NewBlockHandler(svcs.Block, limiters.SocialAction),
		Report:                handlers.NewReportHandler(svcs.Report, svcs.ReportUpload, cfg.Upload.MaxSize),
		Gif:                   handlers.NewGifHandler(cfg.Klipy.APIKey),
		Device:                handlers.NewDeviceHandler(svcs.Device),
		E2EE:                  handlers.NewE2EEHandler(svcs.E2EE, limiters.GroupSession),
		LinkPreview:           handlers.NewLinkPreviewHandler(svcs.LinkPreview),
		Badge:                 handlers.NewBadgeHandler(svcs.Badge, cfg.Upload.Dir),
		Preferences:           handlers.NewPreferencesHandler(svcs.Preferences),
		DownloadPrompt:        handlers.NewDownloadPromptHandler(repos.User),
		Feedback:              handlers.NewFeedbackHandler(svcs.Feedback, svcs.FeedbackUpload, cfg.Upload.MaxSize, limiters.Feedback, svcs.AppLog),
		Diagnostics:           handlers.NewDiagnosticsHandler(svcs.Email, cfg.DiagSMTP.To, svcs.AppLog, cfg.Upload.MaxSize),
		AuditLog:              handlers.NewAuditLogHandler(svcs.AuditLog),
		Soundboard:            handlers.NewSoundboardHandler(svcs.Soundboard, cfg.Upload.MaxSize),
		Emoji:                 handlers.NewEmojiHandler(svcs.Emoji, limiters.Upload),
		Sticker:               handlers.NewStickerHandler(svcs.Sticker, limiters.Upload),
		Entrance:              handlers.NewEntranceHandler(svcs.Entrance, limiters.Upload),
		Cosmetic:              handlers.NewCosmeticHandler(svcs.Cosmetic, limiters.CosmeticEquip),
		ExpressionClone:       handlers.NewExpressionCloneHandler(svcs.ExpressionClone, limiters.Upload),
		Music:                 handlers.NewMusicHandler(svcs.MusicBot, svcs.ChannelPermission, limiters.MusicPlay, musicAccess),
		LiveKitWebhook:        liveKitWebhook,
		ClientLog:             handlers.NewClientLogHandler(svcs.AppLog),
		UploadDownload: handlers.NewUploadDownloadHandler(cfg.Upload.Dir, services.NewMediaAccessService(
			repos.Attachment, repos.Message, repos.DM, svcs.ChannelPermission,
			repos.Report, repos.Feedback, repos.User, repos.MediaAsset, repos.GroupDM,
		), svcs.Auth, botService),
		Notification:    handlers.NewNotificationHandler(svcs.Notification),
		Reminder:        handlers.NewReminderHandler(svcs.Reminder),
		Saved:           handlers.NewSavedHandler(svcs.Saved),
		SpamInbox:       handlers.NewSpamInboxHandler(svcs.SpamInbox),
		MediaLabel:      handlers.NewMediaLabelHandler(svcs.MediaLabel),
		UserNote:        handlers.NewUserNoteHandler(svcs.UserNote),
		DataExport:      handlers.NewDataExportHandler(repos.DataExport),
		Personalization: handlers.NewPersonalizationHandler(svcs.Personalization),
		ClipRecording:   handlers.NewClipRecordingHandler(svcs.ClipRecording),
		ProfileShowcase: handlers.NewProfileShowcaseHandler(svcs.ProfileShowcase),
		ServerEvent:     handlers.NewServerEventHandler(svcs.ServerEvent),
		WS:              ws.NewHandler(hub, svcs.Auth, svcs.WSTicket, nil, svcs.Voice, repos.User, repos.Server, svcs.ServerMute, svcs.ChannelMute, botService, voiceStateFilter),
	}
}
