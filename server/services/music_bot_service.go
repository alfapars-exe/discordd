// Package services — MusicBotService: per-channel YouTube → LiveKit audio bot.
//
// One botInstance per voice channel; multiple channels can host bots
// simultaneously (each is its own goroutine + ffmpeg subprocess + LiveKit
// connection). State is in-memory only and resets on backend restart.
//
// Files in this group:
//   music_bot_service.go   — interface, struct, public commands (this file)
//   music_bot_pipeline.go  — yt-dlp + ffmpeg + Ogg/Opus → LiveKit publish loop
//   music_bot_metadata.go  — yt-dlp metadata + playlist extraction
package services

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"

	lksdk "github.com/livekit/server-sdk-go/v2"
)

// idleLeaveAfter — how long an empty queue + no current track keeps the bot
// idle before it disconnects on its own. Matches Discord's ~2-5 min behaviour.
const idleLeaveAfter = 5 * time.Minute

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
	log.Printf("[music] enqueue request: channel=%s user=%s url=%q", channelID, userID, url)

	channel, err := s.channels.GetByID(ctx, channelID)
	if err != nil {
		log.Printf("[music] enqueue: channel lookup failed channel=%s err=%v", channelID, err)
		return nil, fmt.Errorf("channel lookup failed: %w", err)
	}
	if channel.Type != models.ChannelTypeVoice {
		log.Printf("[music] enqueue: not a voice channel channel=%s type=%s", channelID, channel.Type)
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

	extractStart := time.Now()
	tracks, err := extractTracks(ctx, url, userID, requesterName)
	extractMs := time.Since(extractStart).Milliseconds()
	if err != nil {
		log.Printf("[music] enqueue: yt-dlp extract failed channel=%s url=%q err=%v duration=%dms",
			channelID, url, err, extractMs)
		return nil, fmt.Errorf("yt-dlp extraction failed: %w", err)
	}
	log.Printf("[music] enqueue: extracted %d track(s) channel=%s duration=%dms", len(tracks), channelID, extractMs)
	if len(tracks) == 0 {
		return nil, fmt.Errorf("%w: no playable tracks found at URL", pkg.ErrBadRequest)
	}

	bot, err := s.getOrCreateBot(ctx, channel.ServerID, channelID)
	if err != nil {
		log.Printf("[music] enqueue: getOrCreateBot failed channel=%s err=%v", channelID, err)
		return nil, err
	}

	bot.mu.Lock()
	wasIdle := bot.currentTrack == nil
	bot.queue = append(bot.queue, tracks...)
	bot.user = &requesterMeta{userID: userID, name: requesterName}
	bot.cancelIdleTimer()
	queueLen := len(bot.queue)
	bot.mu.Unlock()

	log.Printf("[music] enqueue: appended channel=%s queue_len=%d wasIdle=%v", channelID, queueLen, wasIdle)

	if wasIdle {
		go s.playLoop(bot)
	}

	s.broadcastState(bot)
	return tracks, nil
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
	go s.broadcastState(bot)
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
	go s.broadcastState(bot)
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
	log.Printf("[music] bot stopped channel=%s", channelID)
	return nil
}

func (s *musicBotService) StopAllForChannel(channelID string) {
	_ = s.Stop(channelID)
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

func (s *musicBotService) logErr(category models.LogCategory, channelID, msg string, meta map[string]string) {
	if s.appLogger == nil {
		log.Printf("[music] %s channel=%s %v", msg, channelID, meta)
		return
	}
	if meta == nil {
		meta = map[string]string{}
	}
	meta["channel_id"] = channelID
	s.appLogger.Log(models.LogLevelError, category, nil, nil, msg, meta)
}
