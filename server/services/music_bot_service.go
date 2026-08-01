// Package services — MusicBotService: per-channel YouTube → LiveKit audio bot.
//
// One botInstance per voice channel; multiple channels can host bots
// simultaneously (each is its own goroutine + ffmpeg subprocess + LiveKit
// connection). State is in-memory only and resets on backend restart.
//
// Files in this group:
//
//	music_bot_service.go   — interface, struct, public commands (this file)
//	music_bot_pipeline.go  — yt-dlp + ffmpeg + Ogg/Opus → LiveKit publish loop
//	music_bot_metadata.go  — yt-dlp metadata + playlist extraction
package services

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"

	lksdk "github.com/livekit/server-sdk-go/v2"
)

// musicBotLogger is shared by every music_bot_*.go file in this package —
// they all implement methods on the single musicBotService/botInstance types.
var musicBotLogger = logx.Component("service.musicbot")

// idleLeaveAfter — how long an empty queue + no current track keeps the bot
// idle before it disconnects on its own. Matches Discord's ~2-5 min behaviour.
const idleLeaveAfter = 5 * time.Minute

// maxConcurrentMusicExtractions bounds concurrent extractTracks calls
// (security scan 2026-07-31, finding N-15): each one spawns a yt-dlp
// subprocess with no prior limit, so an unbounded fan-in of /music/play
// requests was an unauthenticated-per-request fork bomb. Sized like
// maxConcurrentDiagnosticsEmails (handlers/diagnostics.go) -- same shape of
// problem, one subprocess/goroutine per concurrent request.
const maxConcurrentMusicExtractions = 4

// maxQueueLen caps a single channel's music queue (security scan 2026-07-31,
// finding N-15): bot.queue was unbounded, and broadcastState serialises the
// full queue to every connected client on the server on every Enqueue, so an
// unbounded queue is also an unbounded per-message WS payload. 200 tracks is
// generous for a voice-channel session (hours of playback) while bounding
// both the in-memory slice and the broadcast payload size.
const maxQueueLen = 200

// MusicBotService — interface for the HTTP handlers (and voice_state.go's
// "channel emptied → stop bot" hook).
type MusicBotService interface {
	Enqueue(ctx context.Context, userID, channelID, url string) ([]models.MusicTrack, error)
	Skip(channelID string) error
	Pause(channelID string) error
	Resume(channelID string) error
	Stop(channelID string) error
	GetState(channelID string) *models.MusicBotChannelState
	StopAllForChannel(channelID string) // alias of Stop, named for cross-package clarity
}

// MusicBotStopper — the shutdown-path contract, kept separate from
// MusicBotService so main.go can drain the bots without every handler-level
// stub having to implement it.
type MusicBotStopper interface {
	StopAll()
}

// botInstance — one music bot, one voice channel.
//
// Locking: each instance owns its own mu so concurrent commands on different
// channels don't serialise. Service-level `bots` map is protected by the
// outer service.mu (RWMutex). Never hold both — always acquire instance.mu
// after releasing service.mu.
type botInstance struct {
	mu        sync.Mutex
	channelID string
	serverID  string
	roomName  string
	user      *requesterMeta // last user who issued a command (for "requested by" UI)

	lkRoom     *lksdk.Room
	audioTrack *lksdk.LocalSampleTrack

	queue        []models.MusicTrack
	currentTrack *models.MusicTrack
	startedAt    *time.Time
	isPaused     bool

	// Subprocess pipeline. Fresh per track; nil between tracks.
	cmd       *exec.Cmd
	cancelFn  context.CancelFunc
	skipFlag  bool // set by Skip() so playLoop knows it was killed intentionally
	stopFlag  bool // set by Stop() so playLoop exits without restarting
	idleTimer *time.Timer
}

type requesterMeta struct {
	userID string
	name   string
}

type musicBotService struct {
	mu   sync.RWMutex
	bots map[string]*botInstance // channelID → bot

	channels      ChannelGetter
	livekit       LiveKitInstanceGetter
	perms         ChannelPermResolver
	hub           ws.Broadcaster
	encryptionKey []byte
	appLogger     VoiceAppLogger
	users         MusicBotUserGetter

	// playTrackFn is the per-track work seam (mirrors BackupService.runCmd):
	// nil in production, where playLoop falls back to s.playTrack; tests set
	// it so the loop can be driven without real subprocesses.
	playTrackFn func(bot *botInstance, track *models.MusicTrack) error
	// extractTracksFn is the yt-dlp extraction seam, same shape as
	// playTrackFn: nil in production, where Enqueue falls back to the
	// package-level extractTracks; tests substitute a stub so extraction
	// concurrency can be driven without real yt-dlp subprocesses.
	extractTracksFn func(ctx context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error)
	// stallTimeoutOverride / stallPollOverride shrink the stall watchdog's
	// timings for tests. Zero means "use the trackStall* consts".
	stallTimeoutOverride time.Duration
	stallPollOverride    time.Duration

	// extractSem bounds concurrent extractTracks calls to
	// maxConcurrentMusicExtractions (security scan 2026-07-31, finding
	// N-15). Non-blocking acquire (mirrors handlers/diagnostics.go's
	// emailSem): unlike the fire-and-forget diagnostics email, the caller
	// here is a synchronous HTTP request waiting on a response, so a full
	// semaphore returns an explicit busy error instead of silently
	// dropping the request.
	extractSem chan struct{}
}

// MusicBotUserGetter — narrow contract for fetching the requester's display
// name (for the "Requested by" UI line). Satisfied by repository.UserRepository.
type MusicBotUserGetter interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// NewMusicBotService — constructor. Pipeline subprocesses (yt-dlp, ffmpeg)
// are launched lazily on first Enqueue per channel.
func NewMusicBotService(
	channels ChannelGetter,
	livekit LiveKitInstanceGetter,
	perms ChannelPermResolver,
	hub ws.Broadcaster,
	users MusicBotUserGetter,
	encryptionKey []byte,
) MusicBotService {
	return &musicBotService{
		bots:          make(map[string]*botInstance),
		channels:      channels,
		livekit:       livekit,
		perms:         perms,
		hub:           hub,
		encryptionKey: encryptionKey,
		users:         users,
		extractSem:    make(chan struct{}, maxConcurrentMusicExtractions),
	}
}

// SetAppLogger — wire the structured logger after construction (mirror of
// VoiceService.SetAppLogger so init_services.go can keep its symmetric shape).
func (s *musicBotService) SetAppLogger(logger VoiceAppLogger) {
	s.appLogger = logger
}

// Enqueue — add track(s) to the channel's queue. Returns the resolved tracks
// (1 for a single video URL, N for a playlist). Lazy-starts the bot on first
// call per channel. PermSpeak is enforced by the HTTP handler.
func (s *musicBotService) Enqueue(ctx context.Context, userID, channelID, url string) ([]models.MusicTrack, error) {
	musicBotLogger.Info("enqueue request", "channel_id", channelID, "user_id", userID, "url", url)

	channel, err := s.channels.GetByID(ctx, channelID)
	if err != nil {
		musicBotLogger.Error("enqueue: channel lookup failed", "channel_id", channelID, "err", pkg.ErrText(err))
		return nil, fmt.Errorf("channel lookup failed: %w", err)
	}
	if channel.Type != models.ChannelTypeVoice {
		musicBotLogger.Warn("enqueue: not a voice channel", "channel_id", channelID, "channel_type", channel.Type)
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// Resolve requester display name (best-effort — fall back to ID).
	requesterName := userID
	if u, uerr := s.users.GetByID(ctx, userID); uerr == nil {
		requesterName = u.Username
		if u.DisplayName != nil && *u.DisplayName != "" {
			requesterName = *u.DisplayName
		}
	}

	// extractSem bounds concurrent yt-dlp spawns (security scan 2026-07-31,
	// finding N-15). Non-blocking: the caller is a synchronous HTTP request,
	// so when every slot is busy we fail fast with a client-actionable error
	// rather than queuing the request behind a blocking channel send (which
	// would just move the unbounded-fan-in problem from "subprocesses" to
	// "goroutines parked on ctx" and could still pile up past ctx's deadline).
	select {
	case s.extractSem <- struct{}{}:
	default:
		musicBotLogger.Warn("enqueue: extraction backpressure, all slots busy", "channel_id", channelID)
		return nil, fmt.Errorf("%w: music extraction is busy, try again shortly", pkg.ErrBadRequest)
	}

	extract := s.extractTracksFn
	if extract == nil {
		extract = extractTracks
	}
	extractStart := time.Now()
	// The release is deferred inside this closure (rather than a plain
	// statement after the call) so a panic inside extract -- caught further
	// up by middleware.Recover -- can't leak the semaphore slot for the rest
	// of the process's lifetime.
	var tracks []models.MusicTrack
	func() {
		defer func() { <-s.extractSem }()
		tracks, err = extract(ctx, url, userID, requesterName)
	}()
	extractMs := time.Since(extractStart).Milliseconds()
	if err != nil {
		musicBotLogger.Error("enqueue: yt-dlp extract failed",
			"channel_id", channelID, "url", url, "err", pkg.ErrText(err), "duration_ms", extractMs)
		return nil, fmt.Errorf("yt-dlp extraction failed: %w", err)
	}
	musicBotLogger.Info("enqueue: extracted tracks", "track_count", len(tracks), "channel_id", channelID, "duration_ms", extractMs)
	if len(tracks) == 0 {
		return nil, fmt.Errorf("%w: no playable tracks found at URL", pkg.ErrBadRequest)
	}

	bot, err := s.getOrCreateBot(ctx, channel.ServerID, channelID)
	if err != nil {
		musicBotLogger.Error("enqueue: getOrCreateBot failed", "channel_id", channelID, "err", pkg.ErrText(err))
		return nil, err
	}

	bot.mu.Lock()
	wasIdle := bot.currentTrack == nil
	// maxQueueLen cap (security scan 2026-07-31, finding N-15): compute the
	// room BEFORE appending and truncate the accepted slice to fit, rather
	// than appending everything and trimming after -- the untrimmed append
	// would transiently let bot.queue (and the broadcastState payload it
	// feeds) exceed the cap. accepted is what actually lands in the queue,
	// and is what Enqueue returns, so a caller that requested a large
	// playlist can tell it was truncated by comparing len(accepted) to the
	// track count it expected.
	room := maxQueueLen - len(bot.queue)
	if room < 0 {
		room = 0
	}
	accepted := tracks
	truncated := false
	if len(tracks) > room {
		accepted = tracks[:room]
		truncated = true
	}
	bot.queue = append(bot.queue, accepted...)
	bot.user = &requesterMeta{userID: userID, name: requesterName}
	bot.cancelIdleTimer()
	queueLen := len(bot.queue)
	bot.mu.Unlock()

	if truncated {
		musicBotLogger.Warn("enqueue: queue cap reached, extra tracks dropped",
			"channel_id", channelID, "requested", len(tracks), "accepted", len(accepted), "max_queue_len", maxQueueLen)
	}
	musicBotLogger.Info("enqueue: appended to queue", "channel_id", channelID, "queue_len", queueLen, "was_idle", wasIdle)

	if wasIdle {
		logx.Go("service.music_bot.play_loop", func() { s.playLoop(bot) })
	}

	s.broadcastState(bot)
	return accepted, nil
}

// Skip — kill the current track's subprocess; playLoop picks up the next
// track from the queue, or schedules idle-leave if queue is empty.
func (s *musicBotService) Skip(channelID string) error {
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.mu.Lock()
	bot.skipFlag = true
	if bot.cmd != nil && bot.cmd.Process != nil {
		_ = bot.cmd.Process.Kill()
	}
	bot.mu.Unlock()
	return nil
}

// Pause — SIGSTOP the ffmpeg subprocess. The audio track stops emitting
// samples and listeners hear silence; the LiveKit connection stays open.
func (s *musicBotService) Pause(channelID string) error {
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()

	if bot.isPaused || bot.cmd == nil || bot.cmd.Process == nil {
		return nil
	}
	if err := pauseProcess(bot.cmd.Process.Pid); err != nil {
		return fmt.Errorf("pause failed: %w", err)
	}
	bot.isPaused = true
	logx.Go("service.music_bot.broadcast_state", func() { s.broadcastState(bot) })
	return nil
}

func (s *musicBotService) Resume(channelID string) error {
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()

	if !bot.isPaused || bot.cmd == nil || bot.cmd.Process == nil {
		return nil
	}
	if err := resumeProcess(bot.cmd.Process.Pid); err != nil {
		return fmt.Errorf("resume failed: %w", err)
	}
	bot.isPaused = false
	logx.Go("service.music_bot.broadcast_state", func() { s.broadcastState(bot) })
	return nil
}

// Stop — disconnect bot from the channel and clear state. Used by the
// /music/stop endpoint, by the "channel emptied" hook in voice_state.go,
// and by the idle timer. Safe to call when no bot is present.
func (s *musicBotService) Stop(channelID string) error {
	s.mu.Lock()
	bot, ok := s.bots[channelID]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.bots, channelID)
	s.mu.Unlock()

	bot.mu.Lock()
	bot.stopFlag = true
	bot.queue = nil
	bot.currentTrack = nil
	bot.cancelIdleTimer()
	if bot.cmd != nil && bot.cmd.Process != nil {
		_ = bot.cmd.Process.Kill()
	}
	if bot.cancelFn != nil {
		bot.cancelFn()
	}
	bot.mu.Unlock()

	if bot.lkRoom != nil {
		bot.lkRoom.Disconnect()
	}

	// Broadcast a final state with IsActive=false so the frontend can hide
	// the panel without waiting for the next state push.
	s.hub.BroadcastToServer(bot.serverID, ws.Event{
		Op: "music_bot_state",
		Data: map[string]any{
			"channel_id": channelID,
			"server_id":  bot.serverID,
			"state": models.MusicBotChannelState{
				ChannelID: channelID,
				ServerID:  bot.serverID,
				IsActive:  false,
				Queue:     []models.MusicTrack{},
			},
		},
	})
	musicBotLogger.Info("bot stopped", "channel_id", channelID)
	return nil
}

func (s *musicBotService) StopAllForChannel(channelID string) {
	_ = s.Stop(channelID)
}

// StopAll — stop every active bot. Called from main.go's graceful-shutdown
// sequence (before hub.Shutdown, since Stop broadcasts a final state) so
// LiveKit rooms disconnect and the yt-dlp/ffmpeg pairs die on SIGTERM instead
// of being SIGKILLed mid-write when the container runtime reaps the process
// group.
//
// The channel IDs are snapshotted under the read lock first: Stop takes the
// write lock itself, so iterating the map while calling it would deadlock.
func (s *musicBotService) StopAll() {
	s.mu.RLock()
	channelIDs := make([]string, 0, len(s.bots))
	for channelID := range s.bots {
		channelIDs = append(channelIDs, channelID)
	}
	s.mu.RUnlock()

	if len(channelIDs) == 0 {
		return
	}
	musicBotLogger.Info("stopping active bots for shutdown", "count", len(channelIDs))
	for _, channelID := range channelIDs {
		_ = s.Stop(channelID)
	}
}

func (s *musicBotService) GetState(channelID string) *models.MusicBotChannelState {
	bot := s.lookupBot(channelID)
	if bot == nil {
		return nil
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	return bot.snapshotLocked()
}

// ─── helpers ───

func (s *musicBotService) lookupBot(channelID string) *botInstance {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bots[channelID]
}

func (s *musicBotService) getOrCreateBot(ctx context.Context, serverID, channelID string) (*botInstance, error) {
	s.mu.Lock()
	if existing, ok := s.bots[channelID]; ok {
		s.mu.Unlock()
		return existing, nil
	}

	bot := &botInstance{
		channelID: channelID,
		serverID:  serverID,
		roomName:  serverID + ":" + channelID,
	}
	s.bots[channelID] = bot
	s.mu.Unlock()

	if err := s.connectBotToRoom(ctx, bot); err != nil {
		// Roll back map entry on connection failure.
		s.mu.Lock()
		delete(s.bots, channelID)
		s.mu.Unlock()
		return nil, fmt.Errorf("livekit connect failed: %w", err)
	}
	return bot, nil
}

// snapshotLocked — caller must hold bot.mu. Snapshot is safe to broadcast or
// return over HTTP because it's a value copy (queue slice copy + scalar fields).
func (b *botInstance) snapshotLocked() *models.MusicBotChannelState {
	queueCopy := make([]models.MusicTrack, len(b.queue))
	copy(queueCopy, b.queue)
	state := &models.MusicBotChannelState{
		ChannelID: b.channelID,
		ServerID:  b.serverID,
		IsActive:  b.lkRoom != nil,
		Queue:     queueCopy,
		IsPaused:  b.isPaused,
	}
	if b.currentTrack != nil {
		t := *b.currentTrack
		state.CurrentTrack = &t
	}
	if b.startedAt != nil {
		t := *b.startedAt
		state.StartedAt = &t
	}
	return state
}

func (b *botInstance) cancelIdleTimer() {
	if b.idleTimer != nil {
		b.idleTimer.Stop()
		b.idleTimer = nil
	}
}

func (s *musicBotService) broadcastState(bot *botInstance) {
	bot.mu.Lock()
	state := bot.snapshotLocked()
	bot.mu.Unlock()

	s.hub.BroadcastToServer(bot.serverID, ws.Event{
		Op: "music_bot_state",
		Data: map[string]any{
			"channel_id": bot.channelID,
			"server_id":  bot.serverID,
			"state":      state,
		},
	})
}

// broadcastPlaybackError — one-shot event telling clients WHY the bot is about
// to disappear. Sent before Stop()'s IsActive=false state push so the UI has
// the reason in hand when the panel goes away; otherwise the queue would just
// silently vanish.
func (s *musicBotService) broadcastPlaybackError(bot *botInstance, cause error, failures int) {
	s.hub.BroadcastToServer(bot.serverID, ws.Event{
		Op: "music_bot_error",
		Data: map[string]any{
			"channel_id": bot.channelID,
			"server_id":  bot.serverID,
			"reason":     "consecutive_failures",
			"failures":   failures,
			"error":      cause.Error(),
		},
	})
}

func (s *musicBotService) logErr(category models.LogCategory, channelID, msg string, meta map[string]string) {
	if s.appLogger == nil {
		musicBotLogger.Error(msg, "channel_id", channelID, "metadata", meta)
		return
	}
	if meta == nil {
		meta = map[string]string{}
	}
	meta["channel_id"] = channelID
	s.appLogger.Log(models.LogLevelError, category, nil, nil, msg, meta)
}
