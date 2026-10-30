package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type gameActivityHubPresence interface{ IsVisibleOnline(string) (bool, error) }
type gameActivityPresenceAdapter struct{ hub gameActivityHubPresence }

func (a gameActivityPresenceAdapter) IsVisibleOnline(_ context.Context, userID string) (bool, error) {
	if a.hub == nil {
		return false, errors.New("hub presence reader unavailable")
	}
	return a.hub.IsVisibleOnline(userID)
}

// Services holds all service instances.
type Services struct {
	Auth                    services.AuthService
	MFA                     *services.MFAService
	EmailVerification       *services.EmailVerificationService
	EmailCampaign           services.EmailCampaignService
	AccountAssetCleanup     *services.AccountAssetCleanup
	Server                  services.ServerService
	Channel                 services.ChannelService
	Thread                  services.ThreadService
	Category                services.CategoryService
	Message                 services.MessageService
	Upload                  services.UploadService
	DMUpload                services.DMUploadService
	GroupDMUpload           services.GroupDMUploadService
	Member                  services.MemberService
	Role                    services.RoleService
	Voice                   services.VoiceService
	Invite                  services.InviteService
	Pin                     services.PinService
	Search                  services.SearchService
	ReadState               services.ReadStateService
	DM                      services.DMService
	GroupDM                 services.GroupDMService
	Reaction                services.ReactionService
	ChannelPermission       services.ChannelPermissionService
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
	LinkPreview             services.LinkPreviewService
	Badge                   services.BadgeService
	Preferences             services.PreferencesService
	AppLog                  services.AppLogService
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
	MusicBot                services.MusicBotService
	WSTicket                services.WSTicketService
	Backup                  *services.BackupService
	Notification            services.NotificationService
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
	OnlineFriendNotifier    services.OnlineFriendNotifier
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
}

// initServices creates all services. Order matters:
// channelPermService -> voiceService/messageService (dependency)
// voiceService/p2pCallService -> before Hub callbacks (closure scoping)
//
// reachabilityReporter is the readiness cache (constructed in main.go BEFORE
// this call, specifically so it can be threaded through to
// services.NewMetricsCollector below) — nil-safe, so tests/callers that
// don't care about readiness integration can pass nil.
func initServices(db *sql.DB, repos *Repositories, hub ws.EventPublisher, cfg *config.Config, encryptionKey []byte, reachabilityReporter services.LiveKitReachabilityReporter) (*Services, *RateLimiters, services.MetricsCollector) {
	// Order-sensitive services
	channelPermService := services.NewChannelPermissionService(
		repos.ChannelPermission, repos.Role, repos.Channel, hub,
	)
	serverEventService := services.NewServerEventService(repos.ServerEvent, repos.Server, repos.Role, repos.Channel, channelPermService)
	// auditLogService is constructed here, right after channelPermService,
	// so it can be passed as a constructor parameter (not a post-construction
	// setter) to every service that emits moderation audit events below —
	// voiceService immediately after this, plus channelService/memberService/
	// roleService/serverService/messageService further down. A setter that
	// nothing calls compiles fine and silently drops every audit event (see
	// wiring_test.go); a constructor parameter can't be forgotten without a
	// compile error.
	auditLogService := services.NewAuditLogService(repos.AuditLog, repos.User, repos.Role, hub, hub)
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, hub, repos.Server, encryptionKey, repos.MemberTimeout, repos.Ban, auditLogService,
	)
	p2pCallService := services.NewP2PCallService(repos.Friendship, repos.User, hub)

	// Email service (optional)
	var emailSender email.EmailSender
	if cfg.Email.ResendAPIKey != "" && cfg.Email.FromEmail != "" && cfg.Email.AppURL != "" {
		emailSender = email.NewResendSender(cfg.Email.ResendAPIKey, cfg.Email.FromEmail, cfg.Email.AppURL)
		bootLogger.Info("email service enabled", "from", cfg.Email.FromEmail)
	} else {
		bootLogger.Info("email service disabled (RESEND_API_KEY, RESEND_FROM or APP_URL not set)")
	}

	// Remaining services (order-independent)
	inviteService := services.NewInviteService(repos.Invite, repos.Server)
	mfaService := services.NewMFAService(repos.MFA, repos.User, encryptionKey)
	verificationSender, _ := emailSender.(email.VerificationSender)
	categorySender, _ := emailSender.(email.CategorySender)
	emailDeliveryService := services.NewEmailDeliveryService(repos.EmailDelivery, categorySender,
		services.WithEmailUnsubscribe(repos.EmailUnsubscribe, cfg.Email.AppURL))
	if communication, ok := p2pCallService.(interface{ SetEmailEnqueuer(services.EmailEnqueuer) }); ok {
		communication.SetEmailEnqueuer(emailDeliveryService)
	}
	emailVerificationService := services.NewEmailVerificationService(repos.EmailVerification, verificationSender)
	authService := services.NewAuthService(
		repos.User, repos.Session, repos.ResetToken, hub, emailSender,
		cfg.JWT.Secret, cfg.JWT.AccessTokenExpiry, cfg.JWT.RefreshTokenExpiry, services.WithMFA(mfaService), services.WithAuthSessions(repos.AuthSession), services.WithAccountLifecycle(repos.AccountLifecycle), services.WithAccountAnonymization(repos.AccountAnonymization), services.WithApplicationRemoval(repos.ApplicationRemoval), services.WithServerOwnership(repos.ServerOwnership),
	)
	// "Log out from all devices" / password change must also kick any live
	// voice or screen-share session, mirroring adminUserService's ban/delete
	// path (security review 2026-08-01, finding 3). voiceService already
	// exists at this point (constructed above), so no ordering hazard.
	authService.SetVoiceDisconnecter(voiceService)
	channelService := services.NewChannelService(repos.Channel, repos.Category, hub, channelPermService, voiceService, auditLogService, repos.Notification)
	channelDeletionSetter, setterOK := channelService.(interface {
		SetVoiceChannelDeletionHandler(services.VoiceChannelDeletionHandler)
	})
	voiceDeletionHandler, handlerOK := voiceService.(services.VoiceChannelDeletionHandler)
	if !setterOK || !handlerOK {
		panic("channel/voice services must support deleted voice-channel cleanup")
	}
	channelDeletionSetter.SetVoiceChannelDeletionHandler(voiceDeletionHandler)
	threadService := services.NewThreadService(repos.Channel, repos.Message, channelPermService, hub)
	// Enables best-effort on-disk cleanup of attachment files on delete (see
	// services/upload_cleanup.go) without widening the constructor signature
	// — uploadDir stays a setter (unlike auditLogger above) because it's a
	// plain config string, not a dependency other services also need wired
	// before construction.
	channelService.SetUploadDir(cfg.Upload.Dir)
	categoryService := services.NewCategoryService(repos.Category, hub)
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.RoleMention, repos.Role, repos.Reaction, repos.ReadState,
		repos.MemberTimeout, repository.NewMessageTxRunner(db), hub, channelPermService, auditLogService,
		repos.Notification,
	)
	channelMessageNotificationWorker := services.NewChannelMessageNotificationWorker(
		repository.NewSQLiteChannelMessageNotificationQueue(db), repos.Preferences, repos.User, hub,
	)
	messageService.SetUploadDir(cfg.Upload.Dir)
	if database.IsPostgres(db) {
		services.ConfigureChannelDelivery(messageService, db)
		channelMessageNotificationWorker.SetDurablePublication(true)
		if capabilities, ok := hub.(interface{ SetDurableChannelSends(bool) }); ok {
			capabilities.SetDurableChannelSends(true)
		}
	}
	uploadService := services.NewUploadService(repos.Attachment, cfg.Upload.Dir, cfg.Upload.MaxSize)
	profileUpdateNotifier := services.NewProfileUpdateNotifier(repos.Preferences, repos.Friendship, repos.Notification, hub)
	onlineFriendNotifier := services.NewOnlineFriendNotifier(repos.User, repos.Preferences, repos.Friendship, repos.Notification, hub, hub)
	memberService := services.NewMemberService(repos.User, repos.Role, repos.Ban, repos.MemberTimeout, repos.Server, hub, voiceService, auditLogService, profileUpdateNotifier)
	roleService := services.NewRoleService(repos.Role, repos.User, hub, auditLogService)
	// SetPermInvalidator for both is wired in main.go (after initRoutes),
	// not here: it needs to fan out to middleware.PermissionMiddleware too,
	// which is only constructed inside initRoutes. See main.go's comment
	// near initRoutes for the full rationale.
	serverService := services.NewServerService(
		db, repos.Server, repos.LiveKit, repos.Role, repos.Channel,
		repos.Category, repos.User, repos.Ban, inviteService, hub, encryptionKey, auditLogService,
		repository.NewServerMembershipTxRunner(db),
	)
	serverService.SetUploadDir(cfg.Upload.Dir)
	if setter, ok := serverService.(interface {
		SetGameActivityPreferencesRepository(repository.PreferencesRepository)
	}); ok {
		setter.SetGameActivityPreferencesRepository(repos.Preferences)
	}
	livekitAdminService := services.NewLiveKitAdminService(
		repos.LiveKit, repos.Server, repos.User, repos.Channel,
		voiceService, encryptionKey, cfg.HetznerAPIToken, cfg.AllowLiveKitInstanceCreation,
	)
	pinService := services.NewPinService(repos.Pin, repos.Message, repos.Channel, hub, channelPermService)
	// H-05: search results are scoped to the channels the caller may
	// actually read, so it needs both the server's channel list
	// (repos.Channel) and the per-channel permission resolver
	// (channelPermService) — same combination ChannelService.GetAllGrouped
	// already uses for sidebar visibility.
	searchService := services.NewSearchService(repos.Search, repos.Channel, channelPermService)
	readStateService := services.NewReadStateService(repos.ReadState, channelPermService)

	// BlockService before DMService (DMService uses it as BlockChecker)
	blockService := services.NewBlockService(repos.Friendship, repos.User, hub)

	// DMSettingsService before DMService (DMService uses it as DMSettingsUnhider)
	dmSettingsService := services.NewDMSettingsService(repos.DMSettings, repos.DM, hub)

	// Inbox notifications: the read/ack service here, the writers are the
	// message/DM/friendship services below (each takes repos.Notification).
	notificationService := services.NewNotificationService(repos.Notification, hub)

	friendRequestPolicy := services.NewFriendRequestPolicy(
		repos.Preferences,
		func(ctx context.Context, userID string) ([]string, error) {
			friends, err := repos.Friendship.ListFriends(ctx, userID)
			if err != nil {
				return nil, err
			}
			ids := make([]string, 0, len(friends))
			for _, friend := range friends {
				ids = append(ids, friend.UserID)
			}
			return ids, nil
		},
		func(ctx context.Context, userA, userB string) (bool, error) {
			friendship, err := repos.Friendship.GetByPair(ctx, userA, userB)
			if err != nil {
				if errors.Is(err, pkg.ErrNotFound) {
					return false, nil
				}
				return false, err
			}
			return friendship.Status == models.FriendshipStatusAccepted, nil
		},
		repos.Server,
	)
	friendshipService := services.NewFriendshipService(repos.Friendship, repos.User, repos.Notification, hub, friendRequestPolicy)
	friendshipService.SetEmailEnqueuer(emailDeliveryService)
	dmService := services.NewDMService(
		repos.DM, repos.User, hub, blockService, friendshipService, dmSettingsService,
		repos.DMRead, repos.Notification, repository.NewDMMessageTxRunner(db),
	)
	if communication, ok := dmService.(services.DMCommunicationEmailConfigurer); ok {
		communication.SetCommunicationEmailEnqueuer(emailDeliveryService)
	}
	if concreteDMService, ok := dmService.(interface{ SetServerDMPolicy(services.ServerDMPolicy) }); ok {
		concreteDMService.SetServerDMPolicy(services.NewServerDMPolicy(repos.Preferences, repos.Server))
	}
	if reactionDM, ok := dmService.(interface {
		SetReactionPreferences(repository.PreferencesRepository)
	}); ok {
		reactionDM.SetReactionPreferences(repos.Preferences)
	}
	groupDMService := services.NewGroupDMService(repos.GroupDM, repos.User, repos.Friendship, hub, cfg.LiveKit.URL, cfg.LiveKit.APIKey, cfg.LiveKit.APISecret, encryptionKey, cfg.Upload.Dir)
	if reactions, ok := groupDMService.(interface {
		SetReactionDelivery(repository.NotificationRepository, repository.PreferencesRepository, services.BlockChecker)
	}); ok {
		reactions.SetReactionDelivery(repos.Notification, repos.Preferences, blockService)
	}
	dmService.SetUploadDir(cfg.Upload.Dir)
	friendshipService.SetDMAcceptor(dmService) // auto-accept pending DMs when friendship is accepted
	dmUploadService := services.NewDMUploadService(repos.DM, cfg.Upload.Dir, cfg.Upload.MaxSize)
	groupDMUploadService := services.NewGroupDMUploadService(repos.GroupDM, cfg.Upload.Dir, cfg.Upload.MaxSize)
	// Bookmarks (Faz C): saving a channel message is gated on the same
	// per-channel read resolution the message list uses (channelPermService),
	// a DM message on channel membership (repos.DM).
	savedService := services.NewSavedService(repos.Saved, repos.Message, repos.Channel, repos.DM, channelPermService)
	spamInboxService := services.NewSpamInboxService(repository.NewSpamInboxRepository(db), repos.Message, repos.Channel, repos.DM, repos.GroupDM, channelPermService)
	spamInboxService.SetBroadcaster(hub)
	mediaLabelService := services.NewMediaLabelService(repository.NewMediaLabelRepository(db), spamInboxService)
	mediaLabelService.SetBroadcaster(hub)
	reminderService := services.NewReminderService(repos.Reminder, repos.Message, repos.Channel, repos.DM, channelPermService)
	userNoteService := services.NewUserNoteService(repos.UserNote, repos.User)
	profileAudiencePolicy := services.NewProfileAudiencePolicy(repos.Preferences, repos.Friendship, repos.Server)
	personalizationService := services.NewPersonalizationService(repos.Preferences, repos.User, repos.Server, repos.Friendship)
	reactionService := services.NewReactionService(repos.Reaction, repos.Message, repos.Channel, hub, channelPermService, repos.MemberTimeout)
	reactionService.SetNotificationDelivery(repos.Notification, repos.Preferences, repos.User)
	serverMuteService := services.NewServerMuteService(repos.ServerMute)
	channelMuteService := services.NewChannelMuteService(repos.ChannelMute)
	reportService := services.NewReportService(repos.Report, repos.User, messageService, dmService, repos.GroupDM)
	reportUploadService := services.NewReportUploadService(repos.Report, cfg.Upload.Dir, cfg.Upload.MaxSize)

	deviceService := services.NewDeviceService(repos.Device, repository.NewDeviceTxRunner(db), hub, repos.Server)
	// E2EE key-backup integrity MAC key (P0-BD-01): an HKDF subkey of the
	// server master key, so a DB-only tamper of a stored backup is detectable.
	backupHMACKey := crypto.DeriveBackupHMACKey(encryptionKey)
	e2eeService := services.NewE2EEService(repos.E2EEBackup, repos.GroupSession, repos.Device, repos.Server, hub, repos.Channel, channelPermService, backupHMACKey)

	adminUserService := services.NewAdminUserService(repos.User, hub, voiceService, emailSender)
	adminUserService.SetUploadDir(cfg.Upload.Dir)
	adminServerService := services.NewAdminServerService(db, repos.Server, repos.User, repos.LiveKit, hub, emailSender)
	adminServerService.SetUploadDir(cfg.Upload.Dir)

	linkPreviewService := services.NewLinkPreviewService(repos.LinkPreview)
	badgeService := services.NewBadgeService(repos.Badge, hub)
	preferencesService := services.NewPreferencesService(repos.Preferences)
	presenceHub, _ := hub.(gameActivityHubPresence)
	gameActivityPolicy := services.NewGameActivityPrivacyPolicy(repos.Preferences, repos.Friendship, repos.Server, gameActivityPresenceAdapter{hub: presenceHub}, repos.Ban)
	gameActivityService := services.NewGameActivityService(gameActivityPolicy, repos.Friendship, repos.Server, hub)
	gameJoinService := services.NewGameJoinService(gameActivityService, services.NewGameJoinPolicy(gameActivityPolicy, repos.Preferences, repos.Friendship, repos.User, repos.AccountLifecycle, repos.Server, repos.Ban, repos.Channel, channelPermService, voiceService))
	if connector, ok := hub.(interface {
		OnGameJoinOffer(func(string, uint64, any) any)
	}); ok {
		connector.OnGameJoinOffer(func(user string, connection uint64, data any) any {
			raw, err := json.Marshal(data)
			if err != nil || len(raw) > 2048 {
				return nil
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			var input services.GameJoinOfferInput
			if decoder.Decode(&input) != nil {
				return nil
			}
			ctx, cancel := services.BroadcastContext()
			defer cancel()
			return gameJoinService.SetOffer(ctx, user, connection, input)
		})
	}
	if setter, ok := blockService.(interface {
		SetGameActivityPrivacyInvalidator(services.GameActivityPrivacyInvalidator)
	}); ok {
		setter.SetGameActivityPrivacyInvalidator(gameActivityService)
	}
	if setter, ok := friendshipService.(interface {
		SetGameActivityPrivacyInvalidator(services.GameActivityPrivacyInvalidator)
	}); ok {
		setter.SetGameActivityPrivacyInvalidator(gameActivityService)
	}
	if setter, ok := memberService.(interface {
		SetGameActivityPrivacyInvalidator(services.GameActivityPrivacyInvalidator)
	}); ok {
		setter.SetGameActivityPrivacyInvalidator(gameActivityService)
	}
	if setter, ok := serverService.(interface {
		SetGameActivityPrivacyInvalidator(services.GameActivityPrivacyInvalidator)
	}); ok {
		setter.SetGameActivityPrivacyInvalidator(gameActivityService)
	}
	if setter, ok := preferencesService.(interface {
		SetGameActivitySync(services.GameActivityPolicyInvalidator, ws.Broadcaster)
	}); ok {
		setter.SetGameActivitySync(gameActivityService, hub)
	}
	if setter, ok := preferencesService.(interface {
		SetProfileAudienceInvalidator(services.ProfileAudienceInvalidator)
	}); ok {
		setter.SetProfileAudienceInvalidator(profileAudiencePolicy)
	}
	if setter, ok := memberService.(interface {
		SetProfileAudienceInvalidator(services.ProfileAudienceInvalidator)
	}); ok {
		setter.SetProfileAudienceInvalidator(profileAudiencePolicy)
	}
	appLogService := services.NewAppLogService(repos.AppLog)
	clipRecordingService := services.NewClipRecordingService(voiceService, repos.Preferences, appLogService)
	// auditLogService itself was constructed earlier (right after
	// channelPermService above) so it could be passed as a constructor
	// parameter to voice/channel/message/member/role/server services.

	metricsHistoryService := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	feedbackService := services.NewFeedbackService(repos.Feedback)
	feedbackService.SetUploadDir(cfg.Upload.Dir)
	feedbackUploadService := services.NewFeedbackUploadService(repos.Feedback, cfg.Upload.Dir, cfg.Upload.MaxSize)
	soundboardService := services.NewSoundboardService(
		repos.Soundboard, repos.User, hub, voiceService, cfg.Upload.Dir, cfg.Upload.MaxSize,
	)
	// Custom emojis; also the resolver that lets channel and DM reactions
	// use them.
	emojiService := services.NewEmojiService(repos.Emoji, repos.Server, hub, cfg.Upload.Dir)
	reactionService.SetEmojiResolver(emojiService)
	dmService.SetEmojiResolver(emojiService)
	// Server stickers, and copying copyable emojis/stickers between servers.
	stickerService := services.NewStickerService(repos.Sticker, hub, cfg.Upload.Dir)
	expressionCloneService := services.NewExpressionCloneService(repos.Emoji, emojiService, repos.Sticker, stickerService, repos.Server, cfg.Upload.Dir)
	// Entrance sounds: JoinChannel fires the hook on every fresh, authorized
	// voice join; the service broadcasts only to that channel's participants.
	entranceService := services.NewEntranceService(repos.Entrance, repos.Server, repos.Role, repos.Channel,
		channelPermService, hub, voiceService, cfg.Upload.Dir)
	voiceService.SetEntranceHook(entranceService)
	// Profile cosmetics (everyone mode: no shop, no premium tier).
	cosmeticService := services.NewCosmeticService(repos.Cosmetic, repos.Server,
		services.NewEveryoneCosmeticEntitlements(repos.Cosmetic, repos.Server), hub)
	musicBotService := services.NewMusicBotService(
		repos.Channel, repos.LiveKit, channelPermService, hub, repos.User, encryptionKey, appLogService, repos.MusicSession, voiceService,
		services.MusicAudienceDependencies{Voice: voiceService, Members: repos.Server},
	)
	if observer, ok := musicBotService.(services.MusicRequesterRetirementObserver); ok {
		if setter, yes := authService.(interface {
			SetMusicRequesterRetirementObserver(services.MusicRequesterRetirementObserver)
		}); yes {
			setter.SetMusicRequesterRetirementObserver(observer)
		}
	}
	// Wire the channel-empty hook — when the last human leaves, voice service
	// asks music bot to stop so it doesn't keep playing to nobody.
	voiceService.SetMusicBotHook(musicBotService)
	metricsCollector := services.NewMetricsCollector(
		repos.LiveKit, repos.MetricsHistory,
		5*time.Minute,
		30,
		cfg.HetznerAPIToken,
		voiceService,
		reachabilityReporter,
	)

	// Rate limiters
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)
	// Chat messages: 10 per trailing 5s, sliding window, NO hard lockout
	// (cooldown=0). The previous 5/5s fixed window + 15s lockout was
	// trivially tripped by fast-but-normal typists — six quick lines cost a
	// hard 15-second freeze that users read as "sending is stuck". Channel
	// and DM budgets are separate instances so DM traffic can't starve
	// channel sends (or vice versa).
	messageLimiter := ratelimit.NewMessageRateLimiter(10, 5*time.Second, 0)
	dmMessageLimiter := ratelimit.NewMessageRateLimiter(10, 5*time.Second, 0)
	registerLimiter := ratelimit.NewLoginRateLimiter(3, 10*time.Minute) // 3 registrations per 10 min per IP
	forgotPwdLimiter := ratelimit.NewLoginRateLimiter(3, 5*time.Minute) // 3 forgot-password per 5 min per IP
	resetPwdLimiter := ratelimit.NewLoginRateLimiter(5, 5*time.Minute)  // 5 reset attempts per 5 min per IP
	verifyEmailLimiter := ratelimit.NewLoginRateLimiter(10, 5*time.Minute)
	unsubscribeLimiter := ratelimit.NewLoginRateLimiter(20, 5*time.Minute)
	feedbackLimiter := ratelimit.NewMessageRateLimiter(2, 1*time.Minute, 30*time.Second) // 2 feedback per min, 30s cooldown
	// 30/min/IP: a normal client refreshes a ticket on reconnect (~1-3/min
	// even on flaky mobile networks); 30 is generous enough to absorb
	// reconnect storms while killing the brute-force / DoS scenario.
	wsTicketLimiter := ratelimit.NewLoginRateLimiter(30, 1*time.Minute)

	// Uploads: 20 per minute per user, 30s cooldown once exceeded.
	// Sizing rationale: a photo drop of 10 files at once is fine
	// (nowhere near 20/min); a legit chat rarely posts even 5 uploads
	// per minute. 30s cooldown is short enough to not annoy legit users
	// but long enough to make a scripted spam cost noticeable.
	uploadLimiter := ratelimit.NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)

	// DeviceEnum (P0-BD-02): the client fetches public device info / prekey
	// bundles lazily (one bundle per new conversation), so 30/min/IP sits far
	// above legitimate use while making bulk harvesting of the device-key
	// database impractical from a single source.
	deviceEnumLimiter := ratelimit.NewLoginRateLimiter(30, 1*time.Minute)

	// GroupSession (pentest C-03 follow-up finding 3): 20 per minute per
	// user, 30s cooldown once exceeded -- same shape as uploadLimiter above.
	groupSessionLimiter := ratelimit.NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)

	// Refresh (security scan 2026-07-31, finding N-14): 30 per minute per IP,
	// same shape and rationale as wsTicketLimiter above -- refresh is called
	// on reconnect/near-expiry, not per keystroke.
	refreshLimiter := ratelimit.NewLoginRateLimiter(30, 1*time.Minute)

	// MusicPlay (resource scan 2026-08-02): 5 per minute per user, 30s
	// cooldown once exceeded -- see the RateLimiters.MusicPlay doc comment
	// above for the subprocess-cost rationale.
	musicPlayLimiter := ratelimit.NewMessageRateLimiter(5, 1*time.Minute, 30*time.Second)

	// SocialAction (Faz B, 2026-10-21): 20 per minute per user, 30s cooldown
	// once exceeded -- see the RateLimiters.SocialAction doc comment above.
	socialActionLimiter := ratelimit.NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)

	// CosmeticEquip (Faz G1): 10 per minute per user, 30s cooldown once
	// exceeded -- see the RateLimiters.CosmeticEquip doc comment above.
	cosmeticEquipLimiter := ratelimit.NewMessageRateLimiter(10, 1*time.Minute, 30*time.Second)

	svcs := &Services{
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
		WSTicket:                services.NewWSTicketService(),
		Backup:                  services.NewBackupService(cfg.Backup),
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

	limiters := &RateLimiters{
		Login:            loginLimiter,
		Message:          messageLimiter,
		DMMessage:        dmMessageLimiter,
		Register:         registerLimiter,
		ForgotPwd:        forgotPwdLimiter,
		ResetPwd:         resetPwdLimiter,
		VerifyEmail:      verifyEmailLimiter,
		EmailUnsubscribe: unsubscribeLimiter,
		Feedback:         feedbackLimiter,
		WSTicket:         wsTicketLimiter,
		DeviceEnum:       deviceEnumLimiter,
		Upload:           uploadLimiter,
		GroupSession:     groupSessionLimiter,
		Refresh:          refreshLimiter,
		MusicPlay:        musicPlayLimiter,
		SocialAction:     socialActionLimiter,
		CosmeticEquip:    cosmeticEquipLimiter,
	}

	return svcs, limiters, metricsCollector
}
