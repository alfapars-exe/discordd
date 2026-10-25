// Package services — MusicBotService: per-channel YouTube → LiveKit audio bot.
//
// One botInstance per voice channel; multiple channels can host bots
// simultaneously (each is its own goroutine + ffmpeg subprocess + LiveKit
// connection). Queue state is durably restored in a paused state after a
// backend restart; media publication is never resumed without an explicit
// authorized request.
//
// Files in this group:
//
//	music_bot_service.go   — interface, struct, public commands (this file)
//	music_bot_pipeline.go  — yt-dlp + ffmpeg + Ogg/Opus → LiveKit publish loop
//	music_bot_metadata.go  — yt-dlp metadata + playlist extraction
//	music_bot_errors.go    — playback failure reason codes, sentinel errors, stderr tails
package services

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"

	lksdk "github.com/livekit/server-sdk-go/v2"
)

// musicBotLogger is shared by every music_bot_*.go file in this package —
// they all implement methods on the single musicBotService/botInstance types.
var musicBotLogger = logx.Component("service.musicbot")

var ffmpegPath = sync.OnceValues(func() (string, error) { return exec.LookPath("ffmpeg") })

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

// sessionRepoTimeout bounds repository calls made while a bot's durable
// session lock is held, so a stalled database cannot wedge that channel.
const sessionRepoTimeout = 5 * time.Second

// MusicBotService — interface for the HTTP handlers (and voice_state.go's
// "channel emptied → stop bot" hook).
type MusicBotService interface {
	Enqueue(ctx context.Context, userID, channelID, url string) ([]models.MusicTrack, error)
	Skip(channelID string) error
	Pause(channelID string) error
	Resume(channelID string) error
	Stop(channelID string) error
	GetState(channelID string) *models.MusicBotChannelState
	RemoveQueueItem(channelID, queueItemID string, expectedRevision uint64) error
	ReorderQueue(channelID string, queueItemIDs []string, expectedRevision uint64) error
	ShuffleQueue(channelID string, expectedRevision uint64) error
	SetRepeatMode(channelID, mode string) error
	Seek(channelID string, seconds int) error
	Restore(ctx context.Context, channelID string) error
	// StopAllForChannel is used for temporary voice/publication teardown. It
	// preserves an interrupted track and queue as a paused durable session.
	StopAllForChannel(channelID string)
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
// after releasing service.mu, and never take service.mu while holding
// instance.mu. Facts that both sides need travel through fields that need
// neither lock: `stopping` (atomic, set once, never cleared) and
// `ready`/`readyErr` (readyErr is written before ready is closed, and read
// only after it is closed).
type botInstance struct {
	// sessionMu serializes durable queue/session mutations. Lock order is
	// sessionMu then mu; repository calls never hold mu.
	sessionMu sync.Mutex
	// Publication lock follows the global requester privacy fence; never acquire sessionMu from it.
	publicationMu   sync.Mutex
	publishedActive atomic.Bool
	mu              sync.Mutex
	channelID       string
	serverID        string
	roomName        string
	user            *requesterMeta // last user who issued a command (for "requested by" UI)

	// lkRoom / audioTrack are written under mu (connectBotToRoom sets them,
	// stopBot clears them) and read under mu.
	lkRoom     *lksdk.Room
	audioTrack *lksdk.LocalSampleTrack

	// ready is closed once connectBotToRoom has finished, successfully or
	// not; readyErr holds its failure. nil ready means "already connected" —
	// tests seed bots that way. getOrCreateBot never hands out a bot before
	// ready is closed.
	ready    chan struct{}
	readyErr error
	// readyWaits counts waitReady calls that found the connect still in
	// flight. Only tests read it, to know a waiter is parked before they let
	// the connect finish (a seam, like connectBotFn).
	readyWaits atomic.Int32
	// stopping is set by stopBot (and by the idle timer just before it calls
	// stopBot). A stopping bot is never handed out or queued onto again.
	stopping atomic.Bool
	// explicitStop is set by Stop (/music/stop, channel emptied, shutdown)
	// before stopBot. getOrCreateBot and lockLiveBot replace a bot that was
	// stopped under them (the idle timer racing a new /play), but never one
	// stopped on purpose: that would rejoin a channel the user just stopped.
	explicitStop atomic.Bool

	queue        []models.MusicTrack
	sessionID    string
	revision     uint64
	repeatMode   string
	currentTrack *models.MusicTrack
	startedAt    *time.Time
	elapsed      time.Duration
	isPaused     bool
	// loopRunning is true from the Enqueue that starts playLoop until
	// playLoop decides to exit, in the same critical section as that
	// decision. Enqueue starts a loop only when it is false, so two
	// concurrent Enqueues can never start two loops on one bot.
	loopRunning bool

	// Subprocess pipeline. Fresh per track; nil between tracks.
	cmd            *exec.Cmd
	cancelFn       context.CancelFunc
	skipFlag       bool // set by Skip() so playLoop knows it was killed intentionally
	seekRequested  bool
	seekTarget     time.Duration
	playbackOffset time.Duration
	stopFlag       bool // set by stopBot() so playLoop exits without restarting
	idleTimer      *time.Timer
	// idleGen is bumped by cancelIdleTimer. An idle-leave callback that
	// fires after its timer was cancelled (time.Timer.Stop cannot recall a
	// callback that has already started) sees a different value and does
	// nothing.
	idleGen uint64
}

// waitReady blocks until the bot's LiveKit connect has finished and returns
// its error, or returns ctx's error first.
func (b *botInstance) waitReady(ctx context.Context) error {
	if b.ready == nil {
		return nil
	}
	select {
	case <-b.ready:
		return b.readyErr
	default:
	}
	b.readyWaits.Add(1)
	select {
	case <-b.ready:
		return b.readyErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

type requesterMeta struct {
	userID string
	name   string
}

type musicBotService struct {
	musicPublicationMu sync.RWMutex
	mu                 sync.RWMutex
	bots               map[string]*botInstance // channelID → bot
	restored           map[string]models.MusicSession
	// lifecycleLocks serialize channel creation/resume against stop/delete.
	// A fixed stripe set avoids an unbounded per-channel lock registry.
	lifecycleLocks [64]sync.Mutex

	channels      ChannelGetter
	livekit       LiveKitInstanceGetter
	perms         ChannelPermResolver
	hub           ws.Broadcaster
	encryptionKey []byte
	appLogger     VoiceAppLogger
	users         MusicBotUserGetter
	sessions      MusicSessionStore
	roomKeys      MusicRoomKeySource
	audience      MusicAudienceDependencies

	// playTrackFn is the per-track work seam (mirrors BackupService.runCmd):
	// nil in production, where playLoop falls back to s.playTrack; tests set
	// it so the loop can be driven without real subprocesses.
	playTrackFn func(bot *botInstance, track *models.MusicTrack) error
	// extractTracksFn is the yt-dlp extraction seam, same shape as
	// playTrackFn: nil in production, where Enqueue falls back to the
	// package-level extractTracks; tests substitute a stub so extraction
	// concurrency can be driven without real yt-dlp subprocesses.
	extractTracksFn func(ctx context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error)
	// connectBotFn is the LiveKit connect seam, same shape as playTrackFn:
	// nil in production, where getOrCreateBot falls back to
	// s.connectBotToRoom; tests substitute a stub so connect races can be
	// driven without a LiveKit server.
	connectBotFn func(ctx context.Context, bot *botInstance) error
	// restoreSnapshotFn is a synchronization seam for the Stop/Restore race
	// test. It is nil in production.
	restoreSnapshotFn func()
	// stallTimeoutOverride / stallPollOverride shrink the stall watchdog's
	// timings for tests. Zero means "use the trackStall* consts".
	stallTimeoutOverride time.Duration
	stallPollOverride    time.Duration
	// idleLeaveOverride shrinks idleLeaveAfter for tests. Zero means "use
	// the const".
	idleLeaveOverride time.Duration
	// reconnectDelaysOverride replaces the bounded production backoff in
	// tests. An empty slice uses the production sequence.
	reconnectDelaysOverride []time.Duration

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

type MusicSessionStore interface {
	List(context.Context) ([]models.MusicSession, error)
	Save(context.Context, models.MusicSession) error
	Delete(context.Context, string) error
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
	appLogger VoiceAppLogger,
	sessions MusicSessionStore,
	roomKeys MusicRoomKeySource,
	audience ...MusicAudienceDependencies,
) MusicBotService {
	service := &musicBotService{
		bots:          make(map[string]*botInstance),
		restored:      make(map[string]models.MusicSession),
		channels:      channels,
		livekit:       livekit,
		perms:         perms,
		hub:           hub,
		encryptionKey: encryptionKey,
		users:         users,
		appLogger:     appLogger,
		sessions:      sessions,
		roomKeys:      roomKeys,
		extractSem:    make(chan struct{}, maxConcurrentMusicExtractions),
	}
	if len(audience) == 1 {
		service.audience = audience[0]
	}
	if sessions != nil {
		stored, err := sessions.List(context.Background())
		if err != nil {
			musicBotLogger.Error("load paused music sessions", "err", pkg.ErrText(err))
		} else {
			for _, session := range stored {
				if len(session.Queue) > 0 {
					service.restored[session.ChannelID] = session
				}
			}
		}
	}
	return service
}

// Enqueue — add track(s) to the channel's queue. Returns the resolved tracks
// (1 for a single video URL, N for a playlist). Lazy-starts the bot on first
// call per channel. PermSpeak is enforced by the HTTP handler.
func (s *musicBotService) Enqueue(ctx context.Context, userID, channelID, url string) ([]models.MusicTrack, error) {
	if err := RecheckMusicAccess(ctx); err != nil {
		return nil, err
	}
	if ctx.Value(musicCommandContextKey{}) == nil {
		if err := s.CheckLegacyControl(ctx, channelID); err != nil {
			return nil, err
		}
	}
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
	if s.extractTracksFn == nil {
		if _, err := ffmpegPath(); err != nil {
			return nil, &trackPlaybackError{Reason: reasonToolMissing, err: fmt.Errorf("%w: ffmpeg: %w", errToolMissing, err)}
		}
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
	if err := RecheckMusicAccess(ctx); err != nil {
		return nil, err
	}

	// lockLiveBot returns with sessionMu and bot.mu held so the edit and save
	// cannot race another durable queue mutation or play-loop dequeue.
	bot, err := s.lockLiveBot(ctx, channel.ServerID, channelID)
	if err != nil {
		musicBotLogger.Error("enqueue: getOrCreateBot failed", "channel_id", channelID, "err", pkg.ErrText(err))
		return nil, err
	}
	lifecycleLock := s.channelLifecycleLock(channelID)
	lifecycleLocked := true // lockLiveBot returns with this held
	defer func() {
		if lifecycleLocked {
			lifecycleLock.Unlock()
		}
	}()
	releaseLifecycleLock := func() {
		if lifecycleLocked {
			lifecycleLocked = false
			lifecycleLock.Unlock()
		}
	}
	// A natural transition can win after getOrCreateBot read the durable head
	// but before lockLiveBot acquired this session lock. Reject the stale
	// command before assigning queue IDs or changing the live queue.
	if pending, ok := ctx.Value(musicCommandContextKey{}).(*musicPendingCommand); ok {
		if bot.sessionID != pending.operation.SessionID || bot.revision != pending.operation.ExpectedRevision {
			bot.mu.Unlock()
			bot.sessionMu.Unlock()
			releaseLifecycleLock()
			return nil, pkg.ErrConflict
		}
	}

	// Decided in the same critical section as the append: a second Enqueue
	// racing this one sees loopRunning already true and starts no loop.
	// maxQueueLen cap (security scan 2026-07-31, finding N-15): compute the
	// room BEFORE appending and truncate the accepted slice to fit, rather
	// than appending everything and trimming after -- the untrimmed append
	// would transiently let bot.queue (and the broadcastState payload it
	// feeds) exceed the cap. accepted is what actually lands in the queue,
	// and is what Enqueue returns, so a caller that requested a large
	// playlist can tell it was truncated by comparing len(accepted) to the
	// track count it expected.
	room := maxQueueLen - len(bot.queue)
	if room <= 0 {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		releaseLifecycleLock()
		return nil, fmt.Errorf("%w: music queue is full (maximum %d tracks)", pkg.ErrBadRequest, maxQueueLen)
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	previousLoopRunning := bot.loopRunning
	previousUser := bot.user
	startLoop := !bot.loopRunning
	if startLoop {
		bot.loopRunning = true
	}
	accepted := tracks
	truncated := false
	if len(tracks) > room {
		accepted = tracks[:room]
		truncated = true
	}
	accepted = append([]models.MusicTrack(nil), accepted...)
	for i := range accepted {
		accepted[i].QueueItemID = uuid.NewString()
	}
	bot.queue = append(bot.queue, accepted...)
	bot.revision++
	bot.user = &requesterMeta{userID: userID, name: requesterName}
	bot.cancelIdleTimer()
	queueLen := len(bot.queue)
	bot.mu.Unlock()
	if err := s.persistEnqueue(ctx, bot, accepted, userID); err != nil {
		bot.mu.Lock()
		bot.queue = previousQueue
		bot.revision = previousRevision
		bot.loopRunning = previousLoopRunning
		bot.user = previousUser
		repauseRestoredQueue := bot.currentTrack == nil && len(previousQueue) > 0 && !previousLoopRunning && !bot.stopFlag
		if bot.currentTrack == nil && len(bot.queue) == 0 && !bot.loopRunning && !bot.stopFlag {
			// Enqueue canceled the old idle timer before persistence. Restore
			// the idle lifecycle on rollback so a failed save cannot pin an
			// otherwise empty publisher indefinitely.
			s.scheduleIdleLeaveLocked(bot)
		}
		bot.mu.Unlock()
		s.cleanupMusicAttemptBotLocked(ctx, bot)
		if repauseRestoredQueue && !bot.stopping.Load() {
			s.mu.RLock()
			_, hasRestoredSession := s.restored[channelID]
			s.mu.RUnlock()
			if hasRestoredSession {
				// A failed enqueue must not turn a durably paused queue into an
				// active-looking, non-running bot. Keep the restored record and
				// remove only this newly connected in-memory publisher.
				s.stopBotLocked(bot)
			}
		}
		bot.sessionMu.Unlock()
		releaseLifecycleLock()
		return nil, err
	}
	s.mu.Lock()
	delete(s.restored, channelID)
	s.mu.Unlock()
	bot.sessionMu.Unlock()
	releaseLifecycleLock()

	if truncated {
		musicBotLogger.Warn("enqueue: queue cap reached, extra tracks dropped",
			"channel_id", channelID, "requested", len(tracks), "accepted", len(accepted), "max_queue_len", maxQueueLen)
	}
	musicBotLogger.Info("enqueue: appended to queue", "channel_id", channelID, "queue_len", queueLen, "started_loop", startLoop)

	if startLoop {
		logx.Go("service.music_bot.play_loop", func() { s.playLoop(bot) })
	}

	s.broadcastState(bot)
	return accepted, nil
}

// lockLiveBot returns the channel's bot with bot.mu HELD, creating and
// connecting it if needed. A Stop (idle timer, channel emptied, /music/stop)
// can land between getOrCreateBot returning and bot.mu being taken; queueing
// onto that bot would return success while nothing ever plays. So the bot is
// re-checked under its own lock, and a stopped one is replaced once.
func (s *musicBotService) lockLiveBot(ctx context.Context, serverID, channelID string) (*botInstance, error) {
	for attempt := 0; attempt < 2; attempt++ {
		bot, err := s.getOrCreateBot(ctx, serverID, channelID)
		if err != nil {
			return nil, err
		}
		if err := RecheckMusicAccess(ctx); err != nil {
			s.cleanupMusicAttemptBot(ctx, bot)
			return nil, err
		}
		lifecycleLock := s.channelLifecycleLock(channelID)
		lifecycleLock.Lock()
		bot.sessionMu.Lock()
		if err := RecheckMusicAccess(ctx); err != nil {
			s.cleanupMusicAttemptBotLocked(ctx, bot)
			bot.sessionMu.Unlock()
			lifecycleLock.Unlock()
			return nil, err
		}
		bot.mu.Lock()
		if !bot.stopFlag && !bot.stopping.Load() {
			// Caller must release the lifecycle stripe after finishing its
			// session mutation. This keeps Stop/delete ordered without holding
			// the stripe while a LiveKit connect or ready wait is in flight.
			return bot, nil
		}
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		lifecycleLock.Unlock()
		if bot.explicitStop.Load() {
			musicBotLogger.Info("enqueue: bot stopped explicitly, not recreating", "channel_id", channelID)
			return nil, errBotStoppedExplicitly
		}
		musicBotLogger.Info("enqueue: bot stopped concurrently, recreating", "channel_id", channelID)
	}
	return nil, fmt.Errorf("enqueue: %w", errBotStopping)
}

// Skip — kill the current track's subprocess; playLoop picks up the next
// track from the queue, or schedules idle-leave if queue is empty.
func (s *musicBotService) Skip(channelID string) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	bot.skipFlag = true
	if bot.cancelFn != nil {
		bot.cancelFn()
	}
	if bot.cmd != nil && bot.cmd.Process != nil {
		_ = bot.cmd.Process.Kill()
	}
	return nil
}

// Pause gates sample delivery, including while the extractor is starting.
// Backpressure bounds the subprocess buffers. Unlike SIGSTOP this works on
// Windows too, and resume never bursts buffered audio into the room.
func (s *musicBotService) Pause(channelID string) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()

	if bot.isPaused || bot.currentTrack == nil || bot.killRequestedLocked() {
		return nil
	}
	bot.isPaused = true
	logx.Go("service.music_bot.broadcast_state", func() { s.broadcastState(bot) })
	return nil
}

func (s *musicBotService) Resume(channelID string) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()

	if !bot.isPaused || bot.killRequestedLocked() {
		return nil
	}
	bot.isPaused = false
	logx.Go("service.music_bot.broadcast_state", func() { s.broadcastState(bot) })
	return nil
}

// Seek restarts the current finite track at an exact whole-second offset.
// Live streams and unknown-duration media deliberately reject seeking.
func (s *musicBotService) Seek(channelID string, seconds int) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	if bot.currentTrack == nil {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: no track is playing", pkg.ErrBadRequest)
	}
	if bot.currentTrack.DurationSeconds <= 0 {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: live or unknown-duration tracks cannot be seeked", pkg.ErrBadRequest)
	}
	if seconds < 0 || seconds >= bot.currentTrack.DurationSeconds {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: seek position is outside the track", pkg.ErrBadRequest)
	}
	previousSeekTarget := bot.seekTarget
	previousSeekRequested := bot.seekRequested
	previousRevision := bot.revision
	bot.seekTarget = time.Duration(seconds) * time.Second
	bot.seekRequested = true
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistBot(bot); err != nil {
		bot.mu.Lock()
		bot.seekTarget = previousSeekTarget
		bot.seekRequested = previousSeekRequested
		bot.revision = previousRevision
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	if bot.cancelFn != nil {
		bot.cancelFn()
	}
	if bot.cmd != nil && bot.cmd.Process != nil {
		_ = bot.cmd.Process.Kill()
	}
	bot.mu.Unlock()
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) RemoveQueueItem(channelID, queueItemID string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if _, err := uuid.Parse(queueItemID); err != nil {
		return fmt.Errorf("%w: invalid queue item id", pkg.ErrBadRequest)
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	index := -1
	for i := range bot.queue {
		if bot.queue[i].QueueItemID == queueItemID {
			index = i
			break
		}
	}
	if index < 0 {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return pkg.ErrNotFound
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	bot.queue = append(bot.queue[:index], bot.queue[index+1:]...)
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) ReorderQueue(channelID string, queueItemIDs []string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if len(queueItemIDs) > maxQueueLen {
		return fmt.Errorf("%w: queue too large", pkg.ErrBadRequest)
	}
	for _, id := range queueItemIDs {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("%w: invalid queue item id", pkg.ErrBadRequest)
		}
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	if len(queueItemIDs) != len(bot.queue) {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: queue item set mismatch", pkg.ErrBadRequest)
	}
	byID := make(map[string]models.MusicTrack, len(bot.queue))
	for _, track := range bot.queue {
		byID[track.QueueItemID] = track
	}
	reordered := make([]models.MusicTrack, 0, len(bot.queue))
	for _, id := range queueItemIDs {
		track, ok := byID[id]
		if !ok {
			bot.mu.Unlock()
			bot.sessionMu.Unlock()
			return fmt.Errorf("%w: queue item set mismatch", pkg.ErrBadRequest)
		}
		delete(byID, id)
		reordered = append(reordered, track)
	}
	if len(byID) != 0 {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: duplicate queue item", pkg.ErrBadRequest)
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	bot.queue = reordered
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) ShuffleQueue(channelID string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	rand.Shuffle(len(bot.queue), func(i, j int) { bot.queue[i], bot.queue[j] = bot.queue[j], bot.queue[i] }) // #nosec G404 -- playback order is not security-sensitive
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) SetRepeatMode(channelID, mode string) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if mode != "off" && mode != "one" && mode != "all" {
		return fmt.Errorf("%w: invalid repeat mode", pkg.ErrBadRequest)
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		return pkg.ErrNotFound
	}
	bot.sessionMu.Lock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.mu.Lock()
	previousMode := bot.repeatMode
	previousRevision := bot.revision
	bot.repeatMode = mode
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.repeatMode = previousMode; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

// Stop — disconnect the channel's bot and clear its state. Used by the
// /music/stop endpoint and by the "channel emptied" hooks in the voice
// service (via StopAllForChannel). Safe to call when no bot is present.
func (s *musicBotService) Stop(channelID string) error {
	lifecycleLock := s.channelLifecycleLock(channelID)
	lifecycleLock.Lock()
	defer lifecycleLock.Unlock()
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot := s.lookupBot(channelID)
	if bot == nil {
		if s.sessions != nil {
			ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
			err := s.sessions.Delete(ctx, channelID)
			cancel()
			if err != nil {
				return err
			}
		}
		s.mu.Lock()
		delete(s.restored, channelID)
		s.mu.Unlock()
		return nil
	}
	bot.sessionMu.Lock()
	if s.sessions != nil {
		ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
		err := s.sessions.Delete(ctx, channelID)
		cancel()
		if err != nil {
			bot.sessionMu.Unlock()
			return err
		}
	}
	s.mu.Lock()
	delete(s.restored, channelID)
	s.mu.Unlock()
	bot.explicitStop.Store(true)
	s.stopBotLocked(bot)
	bot.sessionMu.Unlock()
	return nil
}

// stopBot — tear down this specific bot. Keyed by identity, not channel: the
// idle timer and playLoop's failure cap call it for the bot they belong to,
// and by then a newer bot may already serve the same channel — it must not
// be the one removed. Idempotent.
//
// Lock order: stopping is set first (no lock), then the map entry is removed
// under s.mu only if it still points at this bot, then bot.mu is taken on
// its own — the two locks are never held together.
func (s *musicBotService) stopBot(bot *botInstance) {
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	s.stopBotLocked(bot)
}

// stopBotLocked performs teardown while the caller holds sessionMu.
func (s *musicBotService) stopBotLocked(bot *botInstance) {
	s.stopBotLockedMode(bot, true)
}

func (s *musicBotService) stopBotLockedMode(bot *botInstance, broadcast bool) {
	bot.stopping.Store(true)

	s.mu.Lock()
	if s.bots[bot.channelID] == bot {
		delete(s.bots, bot.channelID)
	}
	s.mu.Unlock()

	bot.mu.Lock()
	if bot.stopFlag {
		bot.mu.Unlock()
		return
	}
	bot.stopFlag = true
	bot.queue = nil
	bot.currentTrack = nil
	bot.startedAt = nil
	bot.elapsed = 0
	bot.isPaused = false
	bot.cancelIdleTimer()
	if bot.cmd != nil && bot.cmd.Process != nil {
		_ = bot.cmd.Process.Kill()
	}
	if bot.cancelFn != nil {
		bot.cancelFn()
	}
	room := bot.lkRoom
	bot.lkRoom = nil
	bot.audioTrack = nil
	bot.mu.Unlock()

	// Outside bot.mu: Disconnect is a network round-trip.
	if room != nil {
		room.Disconnect()
	}

	// A replacement bot may already serve the channel (an Enqueue landed
	// after the map entry was removed, possibly during Disconnect). Clients
	// key the panel by channel, so this bot's IsActive=false would hide the
	// live bot's panel; the replacement's own state pushes speak for the
	// channel instead. Read under s.mu alone — bot.mu is already released.
	s.mu.RLock()
	current := s.bots[bot.channelID]
	s.mu.RUnlock()
	if current != nil && current != bot {
		musicBotLogger.Info("bot stopped, replacement already serving channel", "channel_id", bot.channelID)
		return
	}

	// Broadcast a final state with IsActive=false so the frontend can hide
	// the panel without waiting for the next state push. broadcastState
	// skips stopping bots, so this is the last state this bot sends.
	s.broadcastPrivateMusicStateConditional(bot, true, !broadcast)
	musicBotLogger.Info("bot stopped", "channel_id", bot.channelID)
}

func (s *musicBotService) StopAllForChannel(channelID string) {
	lifecycleLock := s.channelLifecycleLock(channelID)
	lifecycleLock.Lock()
	defer lifecycleLock.Unlock()
	bot := s.lookupBot(channelID)
	if bot == nil {
		return
	}
	bot.sessionMu.Lock()
	session := s.sessionSnapshot(bot)
	if len(session.Queue) > 0 {
		s.mu.Lock()
		if s.restored == nil {
			s.restored = make(map[string]models.MusicSession)
		}
		s.restored[channelID] = session
		s.mu.Unlock()
		if err := s.saveSession(session); err != nil {
			musicBotLogger.Error("persist paused music session", "channel_id", channelID, "err", pkg.ErrText(err))
		}
	}
	bot.explicitStop.Store(true)
	s.stopBotLocked(bot)
	bot.sessionMu.Unlock()
	if len(session.Queue) > 0 && s.hub != nil {
		s.broadcastPrivateMusicState(bot, true)
	}
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
		s.StopAllForChannel(channelID)
	}
}

func (s *musicBotService) GetState(channelID string) *models.MusicBotChannelState {
	state, _ := s.GetStateWithError(context.Background(), channelID)
	return state
}

func (s *musicBotService) GetStateWithError(ctx context.Context, channelID string) (*models.MusicBotChannelState, error) {
	var result *models.MusicBotChannelState
	err := s.WithPublicMusicState(ctx, channelID, func(state *models.MusicBotChannelState) { result = state })
	return result, err
}

func (s *musicBotService) rawMusicState(ctx context.Context, channelID string) (*models.MusicBotChannelState, error) {
	bot := s.lookupBot(channelID)
	if bot == nil {
		s.mu.RLock()
		restored, ok := s.restored[channelID]
		s.mu.RUnlock()
		if !ok {
			if store, yes := s.sessions.(musicControlStore); yes {
				head, err := store.MusicControlHead(ctx, channelID)
				if err != nil {
					return nil, err
				}
				if head != nil {
					return &models.MusicBotChannelState{ChannelID: head.ChannelID, ServerID: head.ServerID, SessionID: head.SessionID, Revision: head.Revision, IsPaused: true, Queue: []models.MusicTrack{}, RepeatMode: "off"}, nil
				}
			}
			return nil, nil
		}
		queue := append([]models.MusicTrack(nil), restored.Queue...)
		return &models.MusicBotChannelState{SessionID: restored.SessionID, ChannelID: restored.ChannelID, ServerID: restored.ServerID, IsActive: false, IsPaused: true, Queue: queue, Revision: restored.Revision, RepeatMode: restored.RepeatMode}, nil
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	return bot.snapshotLocked(), nil
}

func (s *musicBotService) Restore(ctx context.Context, channelID string) error {
	if err := RecheckMusicAccess(ctx); err != nil {
		return err
	}
	if ctx.Value(musicReconnectContextKey{}) == nil {
		if err := s.CheckLegacyControl(ctx, channelID); err != nil {
			return err
		}
	}
	s.mu.RLock()
	session, ok := s.restored[channelID]
	s.mu.RUnlock()
	if s.restoreSnapshotFn != nil {
		s.restoreSnapshotFn()
	}
	if !ok {
		return pkg.ErrNotFound
	}
	// Revalidate the restored entry after the initial snapshot while holding
	// the same stripe used by Stop. This avoids opening a LiveKit connection
	// when Stop completed in the intervening window.
	lifecycleLock := s.channelLifecycleLock(channelID)
	lifecycleLock.Lock()
	s.mu.RLock()
	_, stillRestored := s.restored[channelID]
	s.mu.RUnlock()
	lifecycleLock.Unlock()
	if !stillRestored {
		return pkg.ErrNotFound
	}
	bot, err := s.lockLiveBot(ctx, session.ServerID, channelID)
	if err != nil {
		return err
	}

	if ctx.Value(musicReconnectContextKey{}) == nil {
		if err := s.CheckLegacyControl(ctx, channelID); err != nil {
			bot.mu.Unlock()
			bot.sessionMu.Unlock()
			s.channelLifecycleLock(channelID).Unlock()
			return err
		}
	}
	lifecycleLock = s.channelLifecycleLock(channelID) // returned held by lockLiveBot
	bot.mu.Unlock()
	if err := RecheckMusicAccess(ctx); err != nil {
		s.cleanupMusicAttemptBotLocked(ctx, bot)
		bot.sessionMu.Unlock()
		lifecycleLock.Unlock()
		return err
	}
	bot.mu.Lock()
	s.mu.RLock()
	_, stillRestored = s.restored[channelID]
	s.mu.RUnlock()
	if !stillRestored {
		wasEmpty := bot.currentTrack == nil && len(bot.queue) == 0 && !bot.loopRunning
		bot.mu.Unlock()
		if wasEmpty {
			// Stop may have cleared the paused session after the initial
			// snapshot, while Restore was waiting for its lifecycle stripe.
			s.stopBotLocked(bot)
		}
		bot.sessionMu.Unlock()
		lifecycleLock.Unlock()
		return pkg.ErrNotFound
	}
	s.mu.Lock()
	delete(s.restored, channelID)
	s.mu.Unlock()
	start := len(bot.queue) > 0 && !bot.loopRunning
	if start {
		bot.loopRunning = true
	}
	bot.isPaused = false
	bot.mu.Unlock()
	bot.sessionMu.Unlock()
	lifecycleLock.Unlock()
	if start {
		logx.Go("service.music_bot.play_loop", func() { s.playLoop(bot) })
	}
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) recoverDisconnectedBot(channelID string) {
	delays := []time.Duration{0, 500 * time.Millisecond, time.Second, 2 * time.Second}
	if len(s.reconnectDelaysOverride) > 0 {
		delays = s.reconnectDelaysOverride
	}
	for attempt, delay := range delays {
		if delay > 0 {
			timer := time.NewTimer(delay)
			<-timer.C
		}
		s.mu.RLock()
		_, stillPending := s.restored[channelID]
		s.mu.RUnlock()
		if !stillPending {
			return // explicitly stopped or already restored elsewhere
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		err := s.Restore(context.WithValue(ctx, musicReconnectContextKey{}, true), channelID)
		cancel()
		if err == nil {
			musicBotLogger.Info("music publisher reconnected", "channel_id", channelID, "attempt", attempt+1)
			return
		}
		musicBotLogger.Warn("music publisher reconnect failed", "channel_id", channelID, "attempt", attempt+1, "err", pkg.ErrText(err))
	}
	// The durable restored entry remains paused for an explicit retry.
	musicBotLogger.Error("music publisher reconnect exhausted", "channel_id", channelID, "attempts", len(delays))
}

// ─── helpers ───

func (s *musicBotService) lookupBot(channelID string) *botInstance {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bots[channelID]
}

func (s *musicBotService) channelLifecycleLock(channelID string) *sync.Mutex {
	// FNV-1a is sufficient here: collisions only serialize unrelated channel
	// operations, never affect correctness.
	const offset32, prime32 = uint32(2166136261), uint32(16777619)
	hash := offset32
	for i := 0; i < len(channelID); i++ {
		hash ^= uint32(channelID[i])
		hash *= prime32
	}
	return &s.lifecycleLocks[hash%uint32(len(s.lifecycleLocks))]
}

func (s *musicBotService) sessionSnapshot(bot *botInstance) models.MusicSession {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	queue := make([]models.MusicTrack, 0, len(bot.queue)+1)
	if bot.currentTrack != nil && !bot.skipFlag {
		queue = append(queue, *bot.currentTrack)
	}
	queue = append(queue, bot.queue...)
	mode := bot.repeatMode
	if mode == "" {
		mode = "off"
	}
	return models.MusicSession{SessionID: bot.sessionID, ChannelID: bot.channelID, ServerID: bot.serverID, Queue: queue, RepeatMode: mode, Revision: bot.revision}
}

func cloneMusicTracks(tracks []models.MusicTrack) []models.MusicTrack {
	return append([]models.MusicTrack(nil), tracks...)
}

func (s *musicBotService) saveSession(session models.MusicSession) error {
	if s.sessions == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
	defer cancel()
	if session.SessionID != "" {
		store, err := s.controlStore()
		if err != nil {
			return err
		}
		head := models.MusicControlHead{ChannelID: session.ChannelID, ServerID: session.ServerID, SessionID: session.SessionID, Revision: session.Revision, MinimumProtocol: 2}
		var persisted *models.MusicSession
		if len(session.Queue) > 0 {
			persisted = &session
		}
		return store.SaveMusicTransition(ctx, head, persisted)
	}
	if len(session.Queue) == 0 {
		return s.sessions.Delete(ctx, session.ChannelID)
	}
	if err := s.sessions.Save(ctx, session); err != nil {
		return fmt.Errorf("persist music session: %w", err)
	}
	return nil
}

func (s *musicBotService) persistBot(bot *botInstance) error {
	if err := s.saveSession(s.sessionSnapshot(bot)); err != nil {
		return err
	}
	s.refreshMusicRequesterCache(bot)
	return nil
}

// persistMutation writes a session snapshot while the caller holds sessionMu.
// On failure rollback runs under mu before the caller releases sessionMu, so
// a later concurrent mutation cannot be undone or persisted out of order.
func (s *musicBotService) persistMutation(bot *botInstance, rollback func()) error {
	err := s.CheckLegacyControl(context.Background(), bot.channelID)
	if err == nil {
		err = s.persistBot(bot)
	}
	if err != nil {
		bot.mu.Lock()
		rollback()
		bot.mu.Unlock()
		return err
	}
	return nil
}

// getOrCreateBot returns the channel's bot once it is connected, creating
// and connecting it if there is none (or only a stopping one).
//
// The new bot is published in s.bots before the connect, so concurrent
// callers find it and wait on its ready channel instead of dialing LiveKit
// twice — but none of them gets the bot until the connect has finished. A
// failed connect is handed to every waiter as an error, and the map entry is
// removed (only if it is still this bot). If the bot was stopped while
// connecting (errBotStopping), the whole thing is retried once with a fresh
// bot.
func (s *musicBotService) getOrCreateBot(ctx context.Context, serverID, channelID string) (*botInstance, error) {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		lifecycleLock := s.channelLifecycleLock(channelID)
		lifecycleLock.Lock()
		var head *models.MusicControlHead
		if store, ok := s.sessions.(musicControlStore); ok {
			head, err = store.MusicControlHead(ctx, channelID)
			if err != nil {
				lifecycleLock.Unlock()
				return nil, err
			}
		}
		if pending, ok := ctx.Value(musicCommandContextKey{}).(*musicPendingCommand); ok {
			if head == nil || head.SessionID != pending.operation.SessionID || head.Revision != pending.operation.ExpectedRevision {
				lifecycleLock.Unlock()
				return nil, pkg.ErrConflict
			}
		}
		if err := RecheckMusicAccess(ctx); err != nil {
			lifecycleLock.Unlock()
			return nil, err
		}
		s.mu.Lock()
		if existing, ok := s.bots[channelID]; ok && !existing.stopping.Load() {
			s.mu.Unlock()
			lifecycleLock.Unlock()
			if err = existing.waitReady(ctx); err == nil {
				if err := RecheckMusicAccess(ctx); err != nil {
					return nil, err
				}
				return existing, nil
			}
			if errors.Is(err, errBotStopping) {
				if existing.explicitStop.Load() {
					return nil, errBotStoppedExplicitly
				}
				continue
			}
			return nil, err
		}

		bot := &botInstance{
			channelID:  channelID,
			serverID:   serverID,
			roomName:   serverID + ":" + channelID,
			ready:      make(chan struct{}),
			repeatMode: "off",
		}
		if restored, ok := s.restored[channelID]; ok {
			bot.queue = append([]models.MusicTrack(nil), restored.Queue...)
			bot.revision = restored.Revision
			bot.repeatMode = restored.RepeatMode
			bot.isPaused = true
		}
		if head != nil {
			bot.sessionID = head.SessionID
			bot.revision = head.Revision
		}
		// Replaces a stopping bot, if any — stopBot's compare-and-delete
		// then leaves this one alone.
		s.bots[channelID] = bot
		markMusicAttemptBot(ctx, bot)
		s.mu.Unlock()
		// The bot is now visible to concurrent callers, which can wait on
		// ready rather than blocking behind the network connection itself.
		lifecycleLock.Unlock()

		cerr := RecheckMusicAccess(ctx)
		if cerr == nil {
			cerr = s.connectBot(ctx, bot)
		}
		if cerr == nil {
			cerr = RecheckMusicAccess(ctx)
		}
		if cerr == nil {
			lifecycleLock.Lock()
			s.mu.Lock()
			stillCurrent := s.bots[channelID] == bot && !bot.stopping.Load()
			s.mu.Unlock()
			lifecycleLock.Unlock()
			if stillCurrent {
				close(bot.ready)
				return bot, nil
			}
			// Stop may have won while connect was in flight. Release its
			// waiters and never hand out or resurrect the stopped bot.
			s.abandonConnectingBot(bot, errBotStopping)
			if bot.explicitStop.Load() {
				return nil, errBotStoppedExplicitly
			}
			continue
		}

		err = fmt.Errorf("livekit connect failed: %w", cerr)
		s.abandonConnectingBot(bot, err)
		if !errors.Is(cerr, errBotStopping) {
			return nil, err
		}
		if bot.explicitStop.Load() {
			return nil, errBotStoppedExplicitly
		}
	}
	return nil, err
}

// connectBot runs the LiveKit connect for a bot getOrCreateBot just
// published. If the connect panics, the bot is abandoned exactly like a
// failed connect before the panic continues up to the HTTP recover
// middleware: otherwise ready would never close, and every later Enqueue on
// the channel would find the bot in the map and block in waitReady until its
// own context ended.
func (s *musicBotService) connectBot(ctx context.Context, bot *botInstance) error {
	connect := s.connectBotFn
	if connect == nil {
		connect = s.connectBotToRoom
	}
	defer func() {
		if r := recover(); r != nil {
			s.abandonConnectingBot(bot, fmt.Errorf("livekit connect panic: %v", r))
			panic(r)
		}
	}()
	return connect(ctx, bot)
}

// abandonConnectingBot marks a bot whose connect did not succeed as stopping,
// removes it from the map (only if it is still this bot), and releases every
// waiter with err. Called exactly once per bot, before ready is closed.
func (s *musicBotService) abandonConnectingBot(bot *botInstance, err error) {
	bot.stopping.Store(true)
	bot.sessionMu.Lock()
	s.preserveMusicAttemptRestoredLocked(bot)
	s.mu.Lock()
	if s.bots[bot.channelID] == bot {
		delete(s.bots, bot.channelID)
	}
	s.mu.Unlock()
	bot.mu.Lock()
	bot.stopFlag = true
	if bot.cancelFn != nil {
		bot.cancelFn()
	}
	room := bot.lkRoom
	bot.lkRoom = nil
	bot.audioTrack = nil
	bot.mu.Unlock()
	bot.sessionMu.Unlock()
	if room != nil {
		room.Disconnect()
	}
	s.broadcastPrivateMusicStateConditional(bot, true, true)
	bot.readyErr = err
	close(bot.ready)
}

// snapshotLocked — caller must hold bot.mu. Snapshot is safe to broadcast or
// return over HTTP because it's a value copy (queue slice copy + scalar fields).
func (b *botInstance) snapshotLocked() *models.MusicBotChannelState {
	queueCopy := make([]models.MusicTrack, len(b.queue))
	copy(queueCopy, b.queue)
	state := &models.MusicBotChannelState{
		SessionID:      b.sessionID,
		ChannelID:      b.channelID,
		ServerID:       b.serverID,
		IsActive:       b.lkRoom != nil,
		Queue:          queueCopy,
		IsPaused:       b.isPaused,
		ElapsedSeconds: b.elapsed.Seconds(),
		Revision:       b.revision,
		RepeatMode:     b.repeatMode,
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

// cancelIdleTimer — caller must hold bot.mu. Bumps idleGen so a callback
// that already fired backs off (see scheduleIdleLeaveLocked).
func (b *botInstance) cancelIdleTimer() {
	b.idleGen++
	if b.idleTimer != nil {
		b.idleTimer.Stop()
		b.idleTimer = nil
	}
}

// broadcastState pushes the bot's current snapshot. Nothing is sent for a
// stopping bot: stopBot sends that bot's final IsActive=false state itself,
// and a late snapshot could otherwise arrive after it and resurrect the
// panel. The check is after the snapshot, so a Stop landing between the
// check and the send can still slip one through; the next state push or the
// client's GET /music/state corrects it.
func (s *musicBotService) broadcastState(bot *botInstance) {
	s.broadcastPrivateMusicState(bot, false)
}

// broadcastPlaybackError — tell clients that a track failed and why, as a
// reason code. playLoop sends one per failed track (fatal=false, failures =
// consecutive failures so far), and one more with fatal=true right before the
// failure cap stops the bot, so it arrives ahead of stopBot's IsActive=false
// state push. Without the per-track event a single bad track would just
// vanish from the panel with no explanation.
//
// Events go only to current participants with fresh channel view rights.
// The payload never carries error
// text — see models.MusicBotErrorPayload. track may be nil.
func (s *musicBotService) broadcastPlaybackError(bot *botInstance, track *models.MusicTrack, reason musicBotErrorReason, failures int, fatal bool) {
	title := ""
	if track != nil {
		title = track.Title
	}
	s.broadcastMusicAudience(bot.serverID, bot.channelID, ws.Event{
		Op: "music_bot_error",
		Data: models.MusicBotErrorPayload{
			ChannelID:  bot.channelID,
			ServerID:   bot.serverID,
			TrackTitle: title,
			Reason:     string(reason),
			Failures:   failures,
			Fatal:      fatal,
		},
	})
}

// context.Background(): logErr fires from the bot's own background playback
// loop, not an HTTP request, so there is no request-scoped context to
// thread through without widening this helper's signature across every
// call site (out of scope for P3.8 — see AppLogService.Log's doc comment).
func (s *musicBotService) logErr(category models.LogCategory, channelID, msg string, meta map[string]string) {
	if s.appLogger == nil {
		musicBotLogger.Error(msg, "channel_id", channelID, "metadata", meta)
		return
	}
	if meta == nil {
		meta = map[string]string{}
	}
	meta["channel_id"] = channelID
	s.appLogger.Log(context.Background(), models.LogLevelError, category, nil, nil, msg, meta)
}
