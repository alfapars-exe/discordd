package main

import (
	"database/sql"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
)

// Repositories holds all repository instances.
type Repositories struct {
	User              repository.UserRepository
	Session           repository.SessionRepository
	Role              repository.RoleRepository
	Channel           repository.ChannelRepository
	Category          repository.CategoryRepository
	Message           repository.MessageRepository
	Attachment        repository.AttachmentRepository
	Ban               repository.BanRepository
	MemberTimeout     repository.MemberTimeoutRepository
	Server            repository.ServerRepository
	Invite            repository.InviteRepository
	Pin               repository.PinRepository
	Search            repository.SearchRepository
	ReadState         repository.ReadStateRepository
	Mention           repository.MentionRepository
	DM                repository.DMRepository
	Reaction          repository.ReactionRepository
	ChannelPermission repository.ChannelPermissionRepository
	Friendship        repository.FriendshipRepository
	LiveKit           repository.LiveKitRepository
	ResetToken        repository.PasswordResetRepository
	MetricsHistory    repository.MetricsHistoryRepository
	ServerMute        repository.ServerMuteRepository
	ChannelMute       repository.ChannelMuteRepository
	DMSettings        repository.DMSettingsRepository
	Report            repository.ReportRepository
	Device            repository.DeviceRepository
	E2EEBackup        repository.E2EEKeyBackupRepository
	GroupSession      repository.GroupSessionRepository
	LinkPreview       repository.LinkPreviewRepository
	Badge             repository.BadgeRepository
	Preferences       repository.PreferencesRepository
	RoleMention       repository.RoleMentionRepository
	AppLog            repository.AppLogRepository
	AuditLog          repository.AuditLogRepository
	Feedback          repository.FeedbackRepository
	Soundboard        repository.SoundboardRepository
	MediaAsset        repository.MediaAssetRepository
}

// initRepositories creates all repositories from the shared DB connection pool.
//
// The pool is wrapped so a statement that fails to PREPARE because Turso
// dropped its Hrana stream is retried on a fresh connection instead of
// surfacing as a 500 — see database/retry.go for why that is safe and why
// registration was the path that exposed it. Transactions deliberately keep
// using the raw connection.
func initRepositories(conn *sql.DB) *Repositories {
	db := database.NewRetryingQuerier(conn)
	return &Repositories{
		User:              repository.NewSQLiteUserRepo(db),
		Session:           repository.NewSQLiteSessionRepo(db),
		Role:              repository.NewSQLiteRoleRepo(db),
		Channel:           repository.NewSQLiteChannelRepo(db),
		Category:          repository.NewSQLiteCategoryRepo(db),
		Message:           repository.NewSQLiteMessageRepo(db),
		Attachment:        repository.NewSQLiteAttachmentRepo(db),
		Ban:               repository.NewSQLiteBanRepo(db),
		MemberTimeout:     repository.NewSQLiteMemberTimeoutRepo(db),
		Server:            repository.NewSQLiteServerRepo(db),
		Invite:            repository.NewSQLiteInviteRepo(db),
		Pin:               repository.NewSQLitePinRepo(db),
		Search:            repository.NewSQLiteSearchRepo(db),
		ReadState:         repository.NewSQLiteReadStateRepo(db),
		Mention:           repository.NewSQLiteMentionRepo(db),
		DM:                repository.NewSQLiteDMRepo(db),
		Reaction:          repository.NewSQLiteReactionRepo(db),
		ChannelPermission: repository.NewSQLiteChannelPermRepo(db),
		Friendship:        repository.NewSQLiteFriendshipRepo(db),
		LiveKit:           repository.NewSQLiteLiveKitRepo(db),
		ResetToken:        repository.NewSQLiteResetTokenRepo(db),
		MetricsHistory:    repository.NewSQLiteMetricsHistoryRepo(db),
		ServerMute:        repository.NewSQLiteServerMuteRepo(db),
		ChannelMute:       repository.NewSQLiteChannelMuteRepo(db),
		DMSettings:        repository.NewSQLiteDMSettingsRepo(db),
		Report:            repository.NewSQLiteReportRepo(db),
		Device:            repository.NewSQLiteDeviceRepo(db),
		E2EEBackup:        repository.NewSQLiteE2EEBackupRepo(db),
		GroupSession:      repository.NewSQLiteGroupSessionRepo(db),
		LinkPreview:       repository.NewSQLiteLinkPreviewRepo(db),
		Badge:             repository.NewSQLiteBadgeRepo(db),
		Preferences:       repository.NewSQLitePreferencesRepo(db),
		RoleMention:       repository.NewSQLiteRoleMentionRepo(db),
		AppLog:            repository.NewSQLiteAppLogRepo(db),
		AuditLog:          repository.NewSQLiteAuditLogRepo(db),
		Feedback:          repository.NewSQLiteFeedbackRepo(db),
		Soundboard:        repository.NewSQLiteSoundboardRepo(db),
		MediaAsset:        repository.NewSQLiteMediaAssetRepo(db),
	}
}
