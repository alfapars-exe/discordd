package main

import (
	"database/sql"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// Services holds all service instances.
type Services struct {
	AuthCache               *middleware.AuthUserCache
	PermissionCache         *middleware.PermissionCache
	Auth                    services.AuthRuntime
	MFA                     *services.MFAService
	EmailVerification       *services.EmailVerificationService
	EmailCampaign           services.EmailCampaignService
	AccountAssetCleanup     *services.AccountAssetCleanup
	Server                  services.ServerService
	Channel                 services.ChannelService
	Thread                  services.ThreadService
	Category                services.CategoryService
	Message                 services.MessageRuntime
	Upload                  services.UploadService
	DMUpload                services.DMUploadRuntime
	GroupDMUpload           services.GroupDMUploadService
	Member                  services.MemberService
	Role                    services.RoleService
	Voice                   services.VoiceRuntime
	Invite                  services.InviteService
	Pin                     services.PinService
	Search                  services.SearchService
	ReadState               services.ReadStateService
	DM                      services.DMRuntime
	GroupDM                 services.GroupDMService
	Reaction                services.ReactionService
	ChannelPermission       services.ChannelPermissionRuntime
	Friendship              services.FriendshipService
	LiveKitAdmin            services.LiveKitAdminService
	P2PCall                 services.P2PCallService
	MetricsHistory          services.MetricsHistoryService
	ServerMute              services.ServerMuteService
	ChannelMute             services.ChannelMuteService
	DMSettings              services.DMSettingsService
	Block                   services.BlockService
	Report                  services.ReportService
	ReportUpload            services.ReportUploadService
	AdminUser               services.AdminUserService
	AdminServer             services.AdminServerService
	Device                  services.DeviceService
	E2EE                    services.E2EEService
	LinkPreview             services.LinkPreviewRuntime
	Badge                   services.BadgeService
	Preferences             services.PreferencesService
	AppLog                  services.AppLogRuntime
	Email                   email.EmailSender
	AuditLog                services.AuditLogService
	Feedback                services.FeedbackService
	FeedbackUpload          services.FeedbackUploadService
	Soundboard              services.SoundboardService
	Emoji                   services.EmojiService
	Sticker                 services.StickerService
	Entrance                services.EntranceService
	Cosmetic                services.CosmeticService
	ExpressionClone         services.ExpressionCloneService
	MusicBot                services.MusicBotRuntime
	WSTicket                services.WSTicketRuntime
	Backup                  *services.BackupService
	Notification            services.NotificationRuntime
	Reminder                services.ReminderService
	ReminderWorker          *services.MessageReminderWorker
	Saved                   services.SavedService
	SpamInbox               *services.SpamInboxService
	MediaLabel              *services.MediaLabelService
	UserNote                services.UserNoteService
	ProfileAudience         services.ProfileAudiencePolicy
	GameActivity            *services.GameActivityService
	GameJoin                *services.GameJoinService
	Personalization         services.PersonalizationService
	ClipRecording           services.ClipRecordingService
	ProfileShowcase         services.ProfileShowcaseService
	ServerEvent             services.ServerEventService
	ServerEventWorker       *services.ServerEventWorker
	FriendAnniversaryWorker *services.FriendAnniversaryWorker
	ChannelNotifWorker      *services.ChannelMessageNotificationWorker
	OnlineFriendNotifier    services.OnlineFriendNotifierRuntime
	EmailDelivery           *services.EmailDeliveryService
}

type RateLimiters struct {
	Login   *ratelimit.LoginRateLimiter
	Message *ratelimit.MessageRateLimiter
	// DMMessage is a SEPARATE instance from Message: the two endpoints used
	// to share one per-user budget, so a busy DM conversation silently ate
	// the channel-send allowance (and vice versa) — surfacing as "random"
	// 429s in whichever surface the user touched second.
	DMMessage        *ratelimit.MessageRateLimiter
	Register         *ratelimit.LoginRateLimiter
	ForgotPwd        *ratelimit.LoginRateLimiter
	ResetPwd         *ratelimit.LoginRateLimiter
	VerifyEmail      *ratelimit.LoginRateLimiter
	EmailUnsubscribe *ratelimit.LoginRateLimiter
	Feedback         *ratelimit.MessageRateLimiter
	// WSTicket added 2026-05-27 (P1-BC-07): /api/auth/ws-ticket was
	// unrate-limited, so an attacker could spam ticket issuance to
	// exhaust ws_ticket_service's in-memory map and degrade legit logins.
	WSTicket *ratelimit.LoginRateLimiter
	// Upload added T3.5: per-user upload rate limit is a separate concern
	// from the message rate limit. Message limit (5/5s) protects against
	// text spam bursts; upload limit (20/min) protects storage/bandwidth
	// from a legitimate user who could otherwise drop hundreds of files
	// per hour without hitting the burst gate.
	Upload *ratelimit.MessageRateLimiter
	// DeviceEnum added 2026-05-29 (P0-BD-02): throttles per-IP enumeration of
	// public E2EE key material (GET /api/users/{id}/devices and
	// .../prekey-bundles), which expose identity keys for arbitrary users.
	DeviceEnum *ratelimit.LoginRateLimiter
	// GroupSession added 2026-07-31 (pentest C-03 follow-up finding 3): caps
	// per-user POST .../group-sessions uploads. Sized like Upload — a
	// distribution is re-sealed per stale channel, not per message, so a
	// legitimate multi-channel re-seal burst stays well under 20/min.
	GroupSession *ratelimit.MessageRateLimiter
	// Refresh added 2026-07-31 (resource scan, finding N-14): POST
	// /api/auth/refresh has no auth middleware (it hands out the auth in the
	// first place) and, before this, no rate limit at all — the only
	// unauthenticated + unthrottled endpoint left after the scan narrowed
	// the original finding. Sized like WSTicket/DeviceEnum: refresh is called
	// on reconnect/near-expiry, not per keystroke, so 30/min/IP is generous
	// for legitimate traffic while bounding brute-force refresh-token guessing.
	Refresh *ratelimit.LoginRateLimiter
	// MusicPlay added 2026-08-02 (resource scan): POST .../music/play had no
	// rate limit at all -- each call can spawn a ~30s yt-dlp subprocess, so an
	// unthrottled caller could pin CPU/bandwidth with a fast loop. 5/min with
	// a 30s cooldown once exceeded (same shape as Upload/GroupSession above):
	// queueing a track is a deliberate per-channel action, not a per-keystroke
	// one, so this is generous for legitimate use while capping subprocess
	// spawn rate. Only Play is limited -- skip/pause/resume/stop/state are
	// cheap in-memory operations on the already-running bot.
	MusicPlay *ratelimit.MessageRateLimiter
	// SocialAction (Faz B, 2026-10-21): POST /api/friends/requests and POST
	// /api/users/{id}/block had no rate limit; both fan out WS events (+ an
	// inbox row for requests), so an unthrottled caller could spam a target.
	// 20/min per user, 30s cooldown (same shape as Upload/GroupSession). One
	// shared budget for both endpoints. Rate limiting bounds frequency, not
	// concurrency -- no semaphore needed here (no CPU/memory-heavy work).
	SocialAction *ratelimit.MessageRateLimiter
	// CosmeticEquip (Faz G1): PUT /api/users/me/cosmetics/equipped and PUT
	// /api/users/me/cosmetics/plain-servers/{serverId}. A global change fans
	// out one WS event to every server the caller is in, so an unthrottled
	// caller could spam N servers per request. 10/min per user, 30s
	// cooldown (same shape as SocialAction). One shared budget for both.
	CosmeticEquip *ratelimit.MessageRateLimiter
	// GameJoin is shared by all game-join endpoints, preserving 60/min per user.
	GameJoin *ratelimit.LoginRateLimiter
}

// initServices creates all services. Order matters:
// channelPermService -> voiceService/messageService (dependency)
// voiceService/p2pCallService -> before Hub callbacks (closure scoping)
//
// reachabilityReporter is the readiness cache (constructed in main.go BEFORE
// this call, specifically so it can be threaded through to
// the operational composition group) — nil-safe, so tests/callers that
// don't care about readiness integration can pass nil.
type serviceHub interface {
	GameActivityEpoch() string
	services.AuthSessionDisconnecter
	services.GameJoinConnectionGate
	ws.EventPublisher
	gameActivityHubPresence
	SetDurableChannelSends(bool)
	OnGameJoinOffer(func(string, uint64, any) any)
}

func initServices(db *sql.DB, repos *Repositories, hub serviceHub, cfg *config.Config, encryptionKey []byte, reachabilityReporter services.LiveKitReachabilityReporter) (*Services, *RateLimiters, services.MetricsCollector) {
	// Own service cache/context resources until the complete bundle is returned.
	// Do not recover here: initialization panics must retain their original value.
	transferred := false
	var rollback []func()
	defer func() {
		if !transferred {
			for i := len(rollback) - 1; i >= 0; i-- {
				rollback[i]()
			}
		}
	}()
	permissions := initPermissionFoundation(permissionFoundationDependencies{Repositories: repos, Hub: hub})
	rollback = append(rollback, permissions.Stop)
	authCache, permissionCache := permissions.Auth, permissions.Server
	channelPermService, permInvalidator := permissions.Channel, permissions.Invalidator
	serverEventService := services.NewServerEventService(repos.ServerEvent, repos.Server, repos.Role, repos.Channel, channelPermService)
	logging := initLoggingServices(loggingDependencies{Repositories: repos, Hub: hub})
	auditLogService, appLogService := logging.Audit, logging.App
	rollback = append(rollback, appLogService.Stop, auditLogService.Stop)
	var entranceService services.EntranceService
	var musicBotService services.MusicBotRuntime
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, hub, repos.Server, encryptionKey, repos.MemberTimeout, repos.Ban, auditLogService,
		services.VoiceRuntimeDependencies{Fanout: services.VoiceFanoutDependencies{Online: hub, Members: repos.Server}, PermissionInvalidations: channelPermService, UsageCredit: services.NewDurableVoiceUsageCredit(repos.LiveKit), UsageRecovery: repos.LiveKit, VoiceAccess: repos.VoiceAccess, FreshPermissions: channelPermService, AppLogger: appLogService, Integrations: func(voice services.VoiceService) (services.VoiceEntranceHook, services.MusicBotChannelHook) {
			entranceService, musicBotService = initVoiceMediaServices(voiceMediaDependencies{Repositories: repos, Hub: hub, Permissions: channelPermService, FreshPermissions: channelPermService, Voice: voice, UploadDir: cfg.Upload.Dir, EncryptionKey: encryptionKey, Logger: appLogService})
			return entranceService, musicBotService
		}},
	)
	rollback = append(rollback, voiceService.ShutdownVoiceStateFanout)

	emailSender := configuredEmailProvider(cfg.Email)

	// Remaining services (order-independent)
	inviteService := services.NewInviteService(repos.Invite, repos.Server)
	communication := initCommunicationServices(communicationDependencies{
		Repositories: repos, Hub: hub, Sender: emailSender, Logger: appLogService, AppURL: cfg.Email.AppURL,
	})
	emailDeliveryService, p2pCallService := communication.EmailDelivery, communication.P2PCall

	channels := initChannelNavigationServices(channelNavigationDependencies{
		Repositories: repos, Hub: hub, Permissions: channelPermService, FreshPermissions: channelPermService,
		VoiceDeletion: voiceService, Audit: auditLogService, UploadDir: cfg.Upload.Dir,
	})
	channelService, threadService, categoryService := channels.Channel, channels.Thread, channels.Category
	pinService, searchService, readStateService := channels.Pin, channels.Search, channels.ReadState
	channelMessaging := initChannelMessagingServices(db, repos, hub, cfg, channelPermService, auditLogService)
	messageService, uploadService := channelMessaging.Message, channelMessaging.Upload
	channelMessageNotificationWorker, deliveryDB := channelMessaging.Notifications, channelMessaging.DeliveryDB

	presenceNotifications := initPresenceNotificationServices(presenceNotificationDependencies{Repositories: repos, Hub: hub})
	profileUpdateNotifier, onlineFriendNotifier := presenceNotifications.ProfileUpdates, presenceNotifications.OnlineFriends
	rollback = append(rollback, onlineFriendNotifier.Stop)
	privacy := initPrivacyPolicies(repos, hub)
	profileAudiencePolicy, gameActivityPolicy := privacy.Profile, privacy.GameActivity
	gameActivityService := services.NewGameActivityService(gameActivityPolicy, repos.Friendship, repos.Server, hub, hub.GameActivityEpoch())
	membership := initMembershipServices(membershipDependencies{
		Database: db, Repositories: repos, Hub: hub, Voice: voiceService,
		Activity: gameActivityService, Profiles: profileAudiencePolicy, Invites: inviteService,
		Audit: auditLogService, UserCache: authCache, Permissions: permInvalidator, ProfileUpdates: profileUpdateNotifier,
		UploadDir: cfg.Upload.Dir, EncryptionKey: encryptionKey,
	})
	memberService, roleService, serverService := membership.Members, membership.Roles, membership.Servers

	social := initSocialMessagingServices(socialMessagingDependencies{
		Database: db, DeliveryDB: deliveryDB, Repositories: repos, Hub: hub, Config: cfg,
		Activity: gameActivityService, Privacy: privacy, Email: emailDeliveryService, EncryptionKey: encryptionKey,
	})
	blockService, dmSettingsService, notificationService := social.Block, social.DMSettings, social.Notification
	emojiService, dmService, friendshipService := social.Emoji, social.DM, social.Friendship
	groupDMService, dmUploadService, groupDMUploadService := social.GroupDM, social.DMUpload, social.GroupDMUpload
	personal := initPersonalMessagingServices(personalMessagingDependencies{Repositories: repos, Permissions: channelPermService})
	savedService, reminderService := personal.Saved, personal.Reminder
	userNoteService, personalizationService := personal.UserNote, personal.Personalization
	moderation := initModerationServices(moderationDependencies{
		Database: db, Repositories: repos, Hub: hub, Permissions: channelPermService,
		Messages: messageService, DMs: dmService, Emoji: emojiService, UploadDir: cfg.Upload.Dir, MaxUploadSize: cfg.Upload.MaxSize,
	})
	spamInboxService, mediaLabelService, reactionService := moderation.SpamInbox, moderation.MediaLabel, moderation.Reaction
	reportService, reportUploadService := moderation.Report, moderation.ReportUpload
	serverMuteService := services.NewServerMuteService(repos.ServerMute)
	channelMuteService := services.NewChannelMuteService(repos.ChannelMute)

	deviceSecurity := initDeviceSecurityServices(deviceSecurityDependencies{
		Database: db, Repositories: repos, Hub: hub, Permissions: channelPermService, EncryptionKey: encryptionKey,
	})
	deviceService, e2eeService := deviceSecurity.Device, deviceSecurity.E2EE

	administration := initAdministrationServices(administrationDependencies{
		Database: db, Repositories: repos, Hub: hub, Voice: voiceService, Email: emailSender,
		UserCache: authCache, Config: cfg, EncryptionKey: encryptionKey,
	})
	adminUserService, adminServerService, livekitAdminService := administration.User, administration.Server, administration.LiveKit

	linkPreviewService := services.NewLinkPreviewService(repos.LinkPreview)
	rollback = append(rollback, linkPreviewService.Stop)
	badgeService := services.NewBadgeService(repos.Badge, hub)

	activityFeatures := initActivityFeatureServices(activityFeatureDependencies{
		Repositories: repos, Hub: hub, Profiles: profileAudiencePolicy, Activity: gameActivityService,
		Policy: gameActivityPolicy, Permissions: channelPermService, FreshPermissions: channelPermService,
		Voice: voiceService, Logger: appLogService,
	})
	preferencesService, gameJoinService, clipRecordingService := activityFeatures.Preferences, activityFeatures.GameJoin, activityFeatures.ClipRecording
	hub.OnGameJoinOffer(gameJoinOfferCallback(gameJoinService))

	operations := initOperationalServices(operationalDependencies{
		Repositories: repos, Config: cfg, ScreenShares: voiceService, Reachability: reachabilityReporter,
	})
	metricsHistoryService, feedbackService, feedbackUploadService := operations.History, operations.Feedback, operations.FeedbackUpload
	metricsCollector := operations.Collector
	rollback = append(rollback, metricsCollector.Stop)
	expressions := initExpressionAssetServices(expressionAssetDependencies{
		Repositories: repos, Hub: hub, Voice: voiceService, Emoji: emojiService,
		UploadDir: cfg.Upload.Dir, MaxUploadSize: cfg.Upload.MaxSize,
	})
	soundboardService, stickerService := expressions.Soundboard, expressions.Sticker
	expressionCloneService, cosmeticService := expressions.Clone, expressions.Cosmetic
	accountSecurity := initAccountSecurityServices(accountSecurityDependencies{
		Repositories: repos, Hub: hub, Config: cfg, Voice: voiceService, Email: emailSender,
		Permissions: permInvalidator, UserCache: authCache, Logger: appLogService,
		MusicRetirement: musicBotService, EncryptionKey: encryptionKey,
	})
	authService, mfaService, emailVerificationService := accountSecurity.Auth, accountSecurity.MFA, accountSecurity.EmailVerification

	wsTicketService := services.NewWSTicketService()
	rollback = append(rollback, wsTicketService.Stop)
	svcs := &Services{
		PermissionCache:         permissionCache,
		AuthCache:               authCache,
		Auth:                    authService,
		MFA:                     mfaService,
		Server:                  serverService,
		Channel:                 channelService,
		Thread:                  threadService,
		Category:                categoryService,
		Message:                 messageService,
		Upload:                  uploadService,
		DMUpload:                dmUploadService,
		GroupDMUpload:           groupDMUploadService,
		Member:                  memberService,
		Role:                    roleService,
		Voice:                   voiceService,
		Invite:                  inviteService,
		Pin:                     pinService,
		Search:                  searchService,
		ReadState:               readStateService,
		DM:                      dmService,
		GroupDM:                 groupDMService,
		Reaction:                reactionService,
		ChannelPermission:       channelPermService,
		Friendship:              friendshipService,
		LiveKitAdmin:            livekitAdminService,
		P2PCall:                 p2pCallService,
		MetricsHistory:          metricsHistoryService,
		ServerMute:              serverMuteService,
		ChannelMute:             channelMuteService,
		DMSettings:              dmSettingsService,
		Block:                   blockService,
		Report:                  reportService,
		ReportUpload:            reportUploadService,
		AdminUser:               adminUserService,
		AdminServer:             adminServerService,
		Device:                  deviceService,
		E2EE:                    e2eeService,
		LinkPreview:             linkPreviewService,
		Badge:                   badgeService,
		Preferences:             preferencesService,
		AppLog:                  appLogService,
		Email:                   emailSender,
		EmailDelivery:           emailDeliveryService,
		EmailVerification:       emailVerificationService,
		EmailCampaign:           services.NewEmailCampaignService(repos.EmailCampaign),
		AccountAssetCleanup:     services.NewAccountAssetCleanup(repos.AccountAssetCleanup, cfg.Upload.Dir),
		AuditLog:                auditLogService,
		Feedback:                feedbackService,
		FeedbackUpload:          feedbackUploadService,
		Soundboard:              soundboardService,
		Emoji:                   emojiService,
		Sticker:                 stickerService,
		Entrance:                entranceService,
		Cosmetic:                cosmeticService,
		ExpressionClone:         expressionCloneService,
		MusicBot:                musicBotService,
		WSTicket:                wsTicketService,
		Backup:                  services.NewBackupService(cfg.Backup, appLogService),
		Notification:            notificationService,
		Reminder:                reminderService,
		ReminderWorker:          services.NewMessageReminderWorker(repos.Reminder, hub),
		Saved:                   savedService,
		SpamInbox:               spamInboxService,
		MediaLabel:              mediaLabelService,
		UserNote:                userNoteService,
		ProfileAudience:         profileAudiencePolicy,
		GameActivity:            gameActivityService,
		GameJoin:                gameJoinService,
		Personalization:         personalizationService,
		ClipRecording:           clipRecordingService,
		ProfileShowcase:         services.NewProfileShowcaseService(repos.ProfileShowcase, repos.Server, profileAudiencePolicy),
		ServerEvent:             serverEventService,
		ServerEventWorker:       services.NewServerEventWorker(repos.ServerEventDelivery, hub),
		FriendAnniversaryWorker: services.NewFriendAnniversaryWorker(repos.FriendAnniversary, hub),
		ChannelNotifWorker:      channelMessageNotificationWorker,
		OnlineFriendNotifier:    onlineFriendNotifier,
	}

	limiters := initRateLimiters(ratelimit.NewLoginRateLimiter, ratelimit.NewMessageRateLimiter)

	transferred = true
	return svcs, limiters, metricsCollector
}
