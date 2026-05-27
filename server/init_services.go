package main

import (
	"database/sql"
	"log"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// Services holds all service instances.
type Services struct {
	Auth              services.AuthService
	Server            services.ServerService
	Channel           services.ChannelService
	Category          services.CategoryService
	Message           services.MessageService
	Upload            services.UploadService
	DMUpload          services.DMUploadService
	Member            services.MemberService
	Role              services.RoleService
	Voice             services.VoiceService
	Invite            services.InviteService
	Pin               services.PinService
	Search            services.SearchService
	ReadState         services.ReadStateService
	DM                services.DMService
	Reaction          services.ReactionService
	ChannelPermission services.ChannelPermissionService
	Friendship        services.FriendshipService
	LiveKitAdmin      services.LiveKitAdminService
	P2PCall           services.P2PCallService
	MetricsHistory    services.MetricsHistoryService
	ServerMute        services.ServerMuteService
	ChannelMute       services.ChannelMuteService
	DMSettings        services.DMSettingsService
	Block             services.BlockService
	Report            services.ReportService
	ReportUpload      services.ReportUploadService
	AdminUser         services.AdminUserService
	AdminServer       services.AdminServerService
	Device            services.DeviceService
	E2EE              services.E2EEService
	LinkPreview       services.LinkPreviewService
	Badge             services.BadgeService
	Preferences       services.PreferencesService
	AppLog            services.AppLogService
	AuditLog          services.AuditLogService
	Feedback          services.FeedbackService
	FeedbackUpload    services.FeedbackUploadService
	Soundboard        services.SoundboardService
	MusicBot          services.MusicBotService
	WSTicket          services.WSTicketService
}

type RateLimiters struct {
	Login     *ratelimit.LoginRateLimiter
	Message   *ratelimit.MessageRateLimiter
	Register  *ratelimit.LoginRateLimiter
	ForgotPwd *ratelimit.LoginRateLimiter
	ResetPwd  *ratelimit.LoginRateLimiter
	Feedback  *ratelimit.MessageRateLimiter
	// WSTicket added 2026-05-27 (P1-BC-07): /api/auth/ws-ticket was
	// unrate-limited, so an attacker could spam ticket issuance to
	// exhaust ws_ticket_service's in-memory map and degrade legit logins.
	WSTicket *ratelimit.LoginRateLimiter
}

// initServices creates all services. Order matters:
// channelPermService -> voiceService/messageService (dependency)
// voiceService/p2pCallService -> before Hub callbacks (closure scoping)
func initServices(db *sql.DB, repos *Repositories, hub ws.EventPublisher, cfg *config.Config, encryptionKey []byte) (*Services, *RateLimiters, services.MetricsCollector) {
	// Order-sensitive services
	channelPermService := services.NewChannelPermissionService(
		repos.ChannelPermission, repos.Role, repos.Channel, hub,
	)
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, hub, repos.Server, encryptionKey,
	)
	p2pCallService := services.NewP2PCallService(repos.Friendship, repos.User, hub)

	// Email service (optional)
	var emailSender email.EmailSender
	if cfg.Email.ResendAPIKey != "" && cfg.Email.FromEmail != "" && cfg.Email.AppURL != "" {
		emailSender = email.NewResendSender(cfg.Email.ResendAPIKey, cfg.Email.FromEmail, cfg.Email.AppURL)
		log.Printf("[main] email service enabled (from=%s)", cfg.Email.FromEmail)
	} else {
		log.Println("[main] email service disabled (RESEND_API_KEY, RESEND_FROM or APP_URL not set)")
	}

	// Remaining services (order-independent)
	inviteService := services.NewInviteService(repos.Invite, repos.Server)
	authService := services.NewAuthService(
		repos.User, repos.Session, repos.ResetToken, hub, emailSender,
		cfg.JWT.Secret, cfg.JWT.AccessTokenExpiry, cfg.JWT.RefreshTokenExpiry,
	)
	channelService := services.NewChannelService(repos.Channel, repos.Category, hub, channelPermService, voiceService)
	categoryService := services.NewCategoryService(repos.Category, hub)
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.RoleMention, repos.Role, repos.Reaction, repos.ReadState,
		repos.MemberTimeout, hub, channelPermService,
	)
	uploadService := services.NewUploadService(repos.Attachment, cfg.Upload.Dir, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(repos.User, repos.Role, repos.Ban, repos.MemberTimeout, repos.Server, hub, voiceService)
	memberService.SetPermInvalidator(channelPermService)
	roleService := services.NewRoleService(repos.Role, repos.User, hub)
	roleService.SetPermInvalidator(channelPermService)
	serverService := services.NewServerService(
		db, repos.Server, repos.LiveKit, repos.Role, repos.Channel,
		repos.Category, repos.User, inviteService, hub, encryptionKey,
	)
	livekitAdminService := services.NewLiveKitAdminService(
		repos.LiveKit, repos.Server, repos.User, repos.Channel,
		voiceService, encryptionKey, cfg.HetznerAPIToken,
	)
	pinService := services.NewPinService(repos.Pin, repos.Message, repos.Channel, hub, channelPermService)
	searchService := services.NewSearchService(repos.Search)
	readStateService := services.NewReadStateService(repos.ReadState, channelPermService)

	// BlockService before DMService (DMService uses it as BlockChecker)
	blockService := services.NewBlockService(repos.Friendship, repos.User, hub)

	// DMSettingsService before DMService (DMService uses it as DMSettingsUnhider)
	dmSettingsService := services.NewDMSettingsService(repos.DMSettings, repos.DM, hub)

	friendshipService := services.NewFriendshipService(repos.Friendship, repos.User, hub)
	dmService := services.NewDMService(repos.DM, repos.User, hub, blockService, friendshipService, dmSettingsService)
	friendshipService.SetDMAcceptor(dmService) // auto-accept pending DMs when friendship is accepted
	dmUploadService := services.NewDMUploadService(repos.DM, cfg.Upload.Dir, cfg.Upload.MaxSize)
	reactionService := services.NewReactionService(repos.Reaction, repos.Message, repos.Channel, hub, channelPermService)
	serverMuteService := services.NewServerMuteService(repos.ServerMute)
	channelMuteService := services.NewChannelMuteService(repos.ChannelMute)
	reportService := services.NewReportService(repos.Report, repos.User)
	reportUploadService := services.NewReportUploadService(repos.Report, cfg.Upload.Dir, cfg.Upload.MaxSize)

	deviceService := services.NewDeviceService(repos.Device, hub)
	e2eeService := services.NewE2EEService(repos.E2EEBackup, repos.GroupSession, hub, repos.Channel, channelPermService)

	adminUserService := services.NewAdminUserService(repos.User, hub, voiceService, emailSender)
	adminServerService := services.NewAdminServerService(repos.Server, repos.User, repos.LiveKit, hub, emailSender)

	linkPreviewService := services.NewLinkPreviewService(repos.LinkPreview)
	badgeService := services.NewBadgeService(repos.Badge, hub)
	preferencesService := services.NewPreferencesService(repos.Preferences)
	appLogService := services.NewAppLogService(repos.AppLog)
	auditLogService := services.NewAuditLogService(repos.AuditLog, repos.User, repos.Role, hub, hub)

	metricsHistoryService := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	feedbackService := services.NewFeedbackService(repos.Feedback)
	feedbackUploadService := services.NewFeedbackUploadService(repos.Feedback, cfg.Upload.Dir, cfg.Upload.MaxSize)
	soundboardService := services.NewSoundboardService(
		repos.Soundboard, repos.User, hub, voiceService, cfg.Upload.Dir, cfg.Upload.MaxSize,
	)
	musicBotService := services.NewMusicBotService(
		repos.Channel, repos.LiveKit, channelPermService, hub, repos.User, encryptionKey,
	)
	// Wire the channel-empty hook — when the last human leaves, voice service
	// asks music bot to stop so it doesn't keep playing to nobody.
	voiceService.SetMusicBotHook(musicBotService)
	metricsCollector := services.NewMetricsCollector(
		repos.LiveKit, repos.MetricsHistory,
		5*time.Minute,
		30,
		cfg.HetznerAPIToken,
		voiceService,
	)

	// Rate limiters
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)
	messageLimiter := ratelimit.NewMessageRateLimiter(5, 5*time.Second, 15*time.Second)
	registerLimiter := ratelimit.NewLoginRateLimiter(3, 10*time.Minute)                  // 3 registrations per 10 min per IP
	forgotPwdLimiter := ratelimit.NewLoginRateLimiter(3, 5*time.Minute)                  // 3 forgot-password per 5 min per IP
	resetPwdLimiter := ratelimit.NewLoginRateLimiter(5, 5*time.Minute)                   // 5 reset attempts per 5 min per IP
	feedbackLimiter := ratelimit.NewMessageRateLimiter(2, 1*time.Minute, 30*time.Second) // 2 feedback per min, 30s cooldown
	// 30/min/IP: a normal client refreshes a ticket on reconnect (~1-3/min
	// even on flaky mobile networks); 30 is generous enough to absorb
	// reconnect storms while killing the brute-force / DoS scenario.
	wsTicketLimiter := ratelimit.NewLoginRateLimiter(30, 1*time.Minute)

	svcs := &Services{
		Auth:              authService,
		Server:            serverService,
		Channel:           channelService,
		Category:          categoryService,
		Message:           messageService,
		Upload:            uploadService,
		DMUpload:          dmUploadService,
		Member:            memberService,
		Role:              roleService,
		Voice:             voiceService,
		Invite:            inviteService,
		Pin:               pinService,
		Search:            searchService,
		ReadState:         readStateService,
		DM:                dmService,
		Reaction:          reactionService,
		ChannelPermission: channelPermService,
		Friendship:        friendshipService,
		LiveKitAdmin:      livekitAdminService,
		P2PCall:           p2pCallService,
		MetricsHistory:    metricsHistoryService,
		ServerMute:        serverMuteService,
		ChannelMute:       channelMuteService,
		DMSettings:        dmSettingsService,
		Block:             blockService,
		Report:            reportService,
		ReportUpload:      reportUploadService,
		AdminUser:         adminUserService,
		AdminServer:       adminServerService,
		Device:            deviceService,
		E2EE:              e2eeService,
		LinkPreview:       linkPreviewService,
		Badge:             badgeService,
		Preferences:       preferencesService,
		AppLog:            appLogService,
		AuditLog:          auditLogService,
		Feedback:          feedbackService,
		FeedbackUpload:    feedbackUploadService,
		Soundboard:        soundboardService,
		MusicBot:          musicBotService,
		WSTicket:          services.NewWSTicketService(),
	}

	limiters := &RateLimiters{
		Login:     loginLimiter,
		Message:   messageLimiter,
		Register:  registerLimiter,
		ForgotPwd: forgotPwdLimiter,
		ResetPwd:  resetPwdLimiter,
		Feedback:  feedbackLimiter,
		WSTicket:  wsTicketLimiter,
	}

	return svcs, limiters, metricsCollector
}
