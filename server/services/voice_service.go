// Package services — VoiceService interface, struct, and construction.
//
// Method implementations are split across concern-based files in this package:
//
//	voice_token.go       — LiveKit token generation (voice + screen share)
//	voice_state.go       — join/leave/update channel + state queries
//	voice_admin.go       — server mute/deafen, move, force-disconnect
//	voice_screenshare.go — screen share viewer tracking
//	voice_lifecycle.go   — orphan/AFK sweeps + LiveKit participant removal
//	voice_e2ee.go        — per-room SFrame passphrase helpers
//
// All files share the single `voiceService` struct and its single `sync.RWMutex`,
// so the concerns can cross-read each other's state without lock-ordering risk.
package services

import (
	"context"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"
)

// voiceLogger is shared by every voice_*.go file in this package — they all
// implement methods on the single voiceService struct (see doc comment above).
var voiceLogger = logx.Component(string(models.LogCategoryVoice))

// ─── ISP Interfaces ───

// ChannelGetter retrieves channel info. Satisfied by repository.ChannelRepository.
type ChannelGetter interface {
	GetByID(ctx context.Context, id string) (*models.Channel, error)
}

// LiveKitInstanceGetter is the slice of LiveKitRepository the voice service
// needs: lookup by server, plus the quota-tracking methods that hook the
// session lifecycle (IncrementMonthlyUsage on leave, GetMonthlyUsage +
// GetNextAutoSwitchInstance + MigrateOneServer on token request). Keeping
// this interface in the services package avoids a cyclic import on the
// repository package while still giving us a narrow contract.
type LiveKitInstanceGetter interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
	IncrementMonthlyUsage(ctx context.Context, instanceID string, year, month, seconds int) error
	GetMonthlyUsage(ctx context.Context, instanceID string, year, month int) (int64, error)
	GetNextAutoSwitchInstance(ctx context.Context, currentID string, year, month int) (*models.LiveKitInstance, error)
	MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error
}

// OnlineUserChecker checks connected users. Used by orphan state cleanup.
type OnlineUserChecker interface {
	GetOnlineUserIDs() []string
}

// AFKTimeoutGetter retrieves a server's AFK timeout and checks server
// membership. Satisfied by repository.ServerRepository. IsMember backs
// JoinChannel's N-01 authorization gate — a WS client can't inject voice
// state for a server it was never added to.
type AFKTimeoutGetter interface {
	GetByID(ctx context.Context, serverID string) (*models.Server, error)
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

// BanChecker — narrow ISP interface so voiceService doesn't depend on the
// full repository contract. repository.BanRepository already implements
// this method. Used by EnforceModerationOnJoin (voice_lifecycle.go).
type BanChecker interface {
	Exists(ctx context.Context, serverID, userID string) (bool, error)
}

// ─── VoiceService Interface ───

type VoiceService interface {
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	GenerateScreenShareToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error
	LeaveChannel(userID string) error
	UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error
	GetChannelParticipants(channelID string) []models.VoiceState
	GetUserVoiceState(userID string) *models.VoiceState
	GetAllVoiceStates() []models.VoiceState
	DisconnectUser(userID string)
	GetStreamCount(channelID string) int
	AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error
	MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error
	AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error
	// GetUserVoiceChannelID returns the user's active voice channel ID (empty if not in voice).
	// Satisfies UserVoiceChannelProvider for ChannelService sidebar visibility.
	GetUserVoiceChannelID(userID string) string
	WatchScreenShare(viewerUserID, streamerUserID string, watching bool)
	GetScreenShareViewerCount(streamerUserID string) int
	// GetAllScreenShareViewers returns streamerUserID -> list of viewer user IDs.
	// Used in voice-state sync so a client joining mid-session sees existing viewers.
	GetAllScreenShareViewers() map[string][]string
	GetScreenShareStats() (streamers int, viewers int)
	CleanupViewersForStreamer(streamerUserID string)
	UpdateActivity(userID string)
	StartOrphanCleanup()
	StartAFKChecker()
	SetAppLogger(logger VoiceAppLogger)
	SetMusicBotHook(hook MusicBotChannelHook)
	// EnforceModerationOnJoin evicts userID from the LiveKit room for
	// (serverID, channelID) if they are currently timed out or banned on
	// serverID. See voice_lifecycle.go for the implementation and the
	// handlers.LiveKitWebhookHandler participant_joined callback (A-29a)
	// that is its only caller.
	EnforceModerationOnJoin(ctx context.Context, serverID, channelID, userID string)
}

// AuditWriter — narrow ISP interface for audit log writes from services.
// Mirrors VoiceAppLogger's pattern: every service that emits audit events
// holds this interface as an optional field (nil = no-op) so wiring stays
// pluggable and there's no circular dependency on services.AuditLogService.
type AuditWriter interface {
	Write(entry models.AuditLog)
}

// MusicBotChannelHook — narrow interface VoiceService uses to stop a music
// bot when the last human leaves the voice channel. Implemented by
// MusicBotService.StopAllForChannel. Nil-safe — feature is optional.
type MusicBotChannelHook interface {
	StopAllForChannel(channelID string)
}

// VoiceAppLogger writes structured logs. ISP interface to avoid importing services.AppLogService.
type VoiceAppLogger interface {
	Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// forceMoveGrant is a one-time permission bypass for a force-moved user.
// Consumed by GenerateToken and expires after 30 seconds as a safety net.
type forceMoveGrant struct {
	channelID string
	expiresAt time.Time
}

// maxScreenShares caps simultaneous screen shares per voice channel.
// 0 disables the cap.
const maxScreenShares = 0

type voiceService struct {
	states             map[string]*models.VoiceState // userID -> VoiceState
	roomPassphrases    map[string]string             // roomName -> E2EE SFrame passphrase
	screenShareViewers map[string]map[string]bool    // streamerUserID -> set of viewerUserIDs
	forceMoveGrants    map[string]forceMoveGrant     // userID -> one-time bypass (consumed on token gen)
	offlineSince       map[string]time.Time          // userID -> first seen offline (grace period tracking)
	mu                 sync.RWMutex

	channelGetter    ChannelGetter
	livekitGetter    LiveKitInstanceGetter
	permResolver     ChannelPermResolver
	hub              ws.Broadcaster
	onlineChecker    OnlineUserChecker
	afkTimeoutGetter AFKTimeoutGetter
	encryptionKey    []byte // AES-256-GCM for LiveKit credential decryption
	appLogger        VoiceAppLogger
	auditLogger      AuditWriter
	musicBotHook     MusicBotChannelHook
	// Wired through NewVoiceService (mirrors reaction_service.go's
	// constructor-injected timeoutChecker) so production wiring cannot
	// silently omit it the way the old SetMemberTimeoutChecker setter
	// could (a call site that forgot the setter compiled fine and left
	// voice joins fail-open). GenerateToken/authorizeJoin reject voice
	// joins from currently timed-out users — matches Discord's "muted
	// means muted everywhere" UX. The nil check at each call site is
	// kept only for test harnesses that intentionally omit a checker
	// (see TestVoiceJoinChannel_NilTimeoutChecker_Allows); production
	// (main.go) always passes repos.MemberTimeout, never nil.
	timeoutChecker MemberTimeoutChecker
	// banChecker backs EnforceModerationOnJoin's ban half (the timeout half
	// reuses timeoutChecker above). Same wiring/nil-guard rationale.
	banChecker BanChecker
}

// MemberTimeoutChecker — narrow ISP interface so voiceService doesn't
// depend on the full repository contract. Repository.MemberTimeoutRepository
// already implements this method.
type MemberTimeoutChecker interface {
	IsActive(ctx context.Context, serverID, userID string) (bool, error)
}

func NewVoiceService(
	channelGetter ChannelGetter,
	livekitGetter LiveKitInstanceGetter,
	permResolver ChannelPermResolver,
	hub ws.Broadcaster,
	onlineChecker OnlineUserChecker,
	afkTimeoutGetter AFKTimeoutGetter,
	encryptionKey []byte,
	timeoutChecker MemberTimeoutChecker,
	banChecker BanChecker,
	auditLogger AuditWriter,
) VoiceService {
	return &voiceService{
		states:             make(map[string]*models.VoiceState),
		roomPassphrases:    make(map[string]string),
		screenShareViewers: make(map[string]map[string]bool),
		forceMoveGrants:    make(map[string]forceMoveGrant),
		offlineSince:       make(map[string]time.Time),
		channelGetter:      channelGetter,
		livekitGetter:      livekitGetter,
		permResolver:       permResolver,
		hub:                hub,
		onlineChecker:      onlineChecker,
		afkTimeoutGetter:   afkTimeoutGetter,
		encryptionKey:      encryptionKey,
		timeoutChecker:     timeoutChecker,
		banChecker:         banChecker,
		auditLogger:        auditLogger,
	}
}

func (s *voiceService) SetMusicBotHook(hook MusicBotChannelHook) {
	s.musicBotHook = hook
}

func (s *voiceService) SetAppLogger(logger VoiceAppLogger) {
	s.appLogger = logger
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
// Keeps call sites to one line and avoids repeating the nil check.
//
// Logs both branches so a "I did X but audit channel is empty" report
// can tell us exactly where the pipeline dropped: nil logger means
// main.go wiring regressed; otherwise look at [audit_log] downstream
// logs from audit_log_service.persistAndBroadcast for Insert/broadcast
// outcomes.
func (s *voiceService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		voiceLogger.Warn("audit event dropped, auditLogger not wired", "event_type", entry.EventType, "server_id", entry.ServerID)
		return
	}
	voiceLogger.Info("audit event emitted", "event_type", entry.EventType, "server_id", entry.ServerID)
	s.auditLogger.Write(entry)
}

// logError writes a structured error log if appLogger is set.
//
// context.Background(): logError/logInfo are called from dozens of sites
// across voice_admin.go/voice_lifecycle.go/voice_token.go, many of them
// background LiveKit reconciliation paths with no request-scoped context at
// all. Threading ctx through every one of those call sites is out of scope
// for P3.8 — see AppLogService.Log's doc comment.
func (s *voiceService) logError(category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(context.Background(), models.LogLevelError, category, userID, nil, message, metadata)
	}
}

// logInfo writes a structured info log if appLogger is set.
// Used for expected-but-noteworthy lifecycle events (orphan cleanup,
// idempotent participant removal) that previously logged as Warn and
// drowned out genuine anomalies in dashboards / alerting.
func (s *voiceService) logInfo(category models.LogCategory, userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(context.Background(), models.LogLevelInfo, category, userID, nil, message, metadata)
	}
}
