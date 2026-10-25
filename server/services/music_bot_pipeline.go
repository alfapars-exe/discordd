package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/logx"

	"github.com/livekit/protocol/auth"
	livekitproto "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

// connectBotToRoom — open the LiveKit connection for a freshly created bot
// instance and publish a 48 kHz stereo Opus audio track. Bot identity is
// `__music_bot__:{channelID}` so multiple channels' bots are distinct
// participants. Token grants RoomJoin + CanPublish + CanSubscribe (false
// for data — bots don't need data channels).
//
// Pipeline subprocesses are NOT started here; that happens lazily inside
// playLoop on the first dequeue. This separation keeps "join + publish"
// fast (sub-second) so the user sees the bot appear in the participant
// list immediately after /play.
func (s *musicBotService) connectBotToRoom(ctx context.Context, bot *botInstance) error {
	musicBotLogger.Info("connectBotToRoom: starting", "channel_id", bot.channelID, "server_id", bot.serverID)
	if s.roomKeys == nil {
		return fmt.Errorf("music room E2EE key source is unavailable")
	}
	keyProvider := &musicRoomKeyProvider{source: s.roomKeys, roomName: bot.roomName}
	keyIndex := keyProvider.CurrentKeyIndex()
	if _, err := keyProvider.GetKey(keyIndex); err != nil {
		return fmt.Errorf("prepare music room E2EE key: %w", err)
	}
	frameEncryptor, err := lksdk.NewFrameEncryptor(keyProvider, lksdk.CodecOpus)
	if err != nil {
		return fmt.Errorf("prepare music Opus frame encryption: %w", err)
	}
	lkInstance, err := s.livekit.GetByServerID(ctx, bot.serverID)
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: livekit instance lookup failed", "server_id", bot.serverID, "err", pkg.ErrText(err))
		return fmt.Errorf("livekit instance lookup: %w", err)
	}
	musicBotLogger.Info("connectBotToRoom: livekit instance resolved",
		"url", lkInstance.URL, "self_hosted", !lkInstance.IsPlatformManaged)

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: api key decrypt failed", "instance_id", lkInstance.ID, "err", pkg.ErrText(err))
		return fmt.Errorf("api key decrypt: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: api secret decrypt failed", "instance_id", lkInstance.ID, "err", pkg.ErrText(err))
		return fmt.Errorf("api secret decrypt: %w", err)
	}

	canPublish := true
	canSubscribe := true
	canPublishData := false

	at := auth.NewAccessToken(apiKey, apiSecret)
	at.SetVideoGrant(&auth.VideoGrant{
		RoomJoin:       true,
		Room:           bot.roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}).
		SetIdentity(models.MusicBotUserID + ":" + bot.channelID).
		SetName("MusicBot").
		SetValidFor(24 * time.Hour)

	token, err := at.ToJWT()
	if err != nil {
		return fmt.Errorf("jwt: %w", err)
	}

	musicBotLogger.Info("connectBotToRoom: dialing livekit", "url", lkInstance.URL, "room", bot.roomName)
	room := lksdk.NewRoom(&lksdk.RoomCallback{
		OnDisconnected: func() {
			musicBotLogger.Info("bot disconnected", "channel_id", bot.channelID)
			if !bot.stopping.Load() {
				// Preserve the interrupted track and pending queue. Rejoining and
				// resuming is deliberately explicit: an unattended backend or
				// LiveKit reconnect must never make the bot start playing again.
				logx.Go("service.music_bot.disconnected", func() {
					s.StopAllForChannel(bot.channelID)
					s.recoverDisconnectedBot(bot.channelID)
				})
			}
		},
	})
	err = room.JoinWithContextAndToken(ctx, lkInstance.URL, token, lksdk.WithConnectTimeout(10*time.Second))
	if err != nil {
		room.Disconnect()
		musicBotLogger.Error("connectBotToRoom: livekit dial failed", "url", lkInstance.URL, "err", pkg.ErrText(err))
		return fmt.Errorf("livekit connect: %w", err)
	}
	musicBotLogger.Info("connectBotToRoom: livekit connected", "room", bot.roomName)

	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	}, lksdk.WithFrameEncryptor(frameEncryptor))
	if err != nil {
		room.Disconnect()
		musicBotLogger.Error("connectBotToRoom: track create failed", "err", pkg.ErrText(err))
		return fmt.Errorf("track create: %w", err)
	}

	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:       "music",
		Source:     livekitproto.TrackSource_MICROPHONE,
		Stereo:     true,
		DisableDTX: true,
		Encryption: livekitproto.Encryption_GCM,
	})
	if err != nil {
		room.Disconnect()
		musicBotLogger.Error("connectBotToRoom: publish track failed", "err", pkg.ErrText(err))
		return fmt.Errorf("publish track: %w", err)
	}

	// Publish under bot.mu. If stopBot ran while we were dialing, it found
	// no room to disconnect — so this connection is ours to close, or it
	// would leak a ghost participant in the LiveKit room.
	bot.mu.Lock()
	if bot.stopFlag || bot.stopping.Load() {
		bot.mu.Unlock()
		room.Disconnect()
		musicBotLogger.Info("connectBotToRoom: bot stopped while dialing, disconnected", "channel_id", bot.channelID)
		return errBotStopping
	}
	bot.lkRoom = room
	bot.audioTrack = track
	bot.mu.Unlock()
	musicBotLogger.Info("bot joined room",
		"room", bot.roomName, "identity", models.MusicBotUserID+":"+bot.channelID, "pub_sid", pub.SID())
	return nil
}

const (
	// trackStallTimeout — how long the pipeline may produce no Ogg page before
	// the watchdog declares the track wedged. Generous relative to the ~20 ms
	// page cadence of a healthy stream, so buffering hiccups never trip it.
	trackStallTimeout = 45 * time.Second
	// trackStallPollInterval — how often the watchdog compares last-progress
	// against the timeout.
	trackStallPollInterval = 5 * time.Second
	// maxConsecutiveTrackFailures — back-to-back playTrack failures tolerated
	// before the bot gives up on the channel. A missing/broken yt-dlp fails
	// instantly on every track, so an uncapped "continue to the next one"
	// burns the entire queue in a tight loop.
	maxConsecutiveTrackFailures = 3
	// playTrackReapGrace — after the pump returns, how long playTrack lets
	// yt-dlp and ffmpeg exit on their own before killing them.
	playTrackReapGrace = 3 * time.Second
	// subprocessWaitDelay — exec.Cmd.WaitDelay for both subprocesses: bounds
	// how long Wait blocks on a process that ignores the kill or on a stderr
	// pipe that stays open after the process exits.
	subprocessWaitDelay = 5 * time.Second
)

// playLoop — the per-bot driver goroutine. Dequeues tracks one at a time and
// drives the yt-dlp → ffmpeg → Opus → LiveKit pipeline for each. When the
// queue empties, schedules an idle-leave timer; another Enqueue arriving
// before the timer fires cancels it and restarts the loop.
//
// Every failed track is broadcast as a non-fatal music_bot_error with its
// reason code. A panic inside the per-track work is recovered (safePlay) and
// counted as a failure, so one bad track cannot wedge the bot.
//
// Exits when:
//   - bot.stopFlag is set (stopBot() was called) — bot already disconnected
//   - the queue drains (idle-leave timer armed)
//   - maxConsecutiveTrackFailures tracks fail back to back (one more,
//     fatal, music_bot_error, then stopBot)
//
// In the first two cases loopRunning is cleared in the same critical section
// that decides to exit, so the next Enqueue starts a fresh loop (the third
// leaves it set on a stopped bot, which is never queued onto again). Any other
// exit (a panic outside safePlay) is caught by the deferred cleanup below,
// which does the same and arms the idle timer.
func (s *musicBotService) playLoop(bot *botInstance) {
	// Seam for tests (mirrors BackupService.runCmd): production runs the real
	// subprocess pipeline, tests substitute a stub so the loop's control flow
	// can be exercised without yt-dlp/ffmpeg.
	play := s.playTrackFn
	if play == nil {
		play = s.playTrack
	}

	cleanExit := false
	defer func() {
		if cleanExit {
			return
		}
		bot.mu.Lock()
		bot.loopRunning = false
		bot.currentTrack = nil
		bot.startedAt = nil
		bot.elapsed = 0
		bot.isPaused = false
		if !bot.stopFlag && !bot.stopping.Load() {
			s.scheduleIdleLeaveLocked(bot)
		}
		bot.mu.Unlock()
		s.broadcastState(bot)
	}()

	consecutiveFailures := 0
	for {
		next, step := s.nextTrack(bot)
		switch step {
		case loopStopped:
			cleanExit = true
			return
		case loopDrained:
			cleanExit = true
			s.broadcastState(bot)
			return
		}

		s.broadcastState(bot)

		var err error
		for {
			err = s.safePlay(play, bot, &next)
			if !s.prepareSeekReplay(bot) {
				break
			}
			s.broadcastState(bot)
		}
		if err == nil {
			// Only CONSECUTIVE failures count — one good track means the
			// pipeline works and the earlier errors were per-video duds.
			consecutiveFailures = 0
			s.repeatCompletedTrack(bot, next)
			continue
		}

		consecutiveFailures++
		reason := playbackReason(err)
		s.logErr(models.LogCategoryVoice, bot.channelID, "music playback failed", map[string]string{
			"video_id":             next.VideoID,
			"error":                pkg.ErrText(err),
			"reason":               string(reason),
			"consecutive_failures": strconv.Itoa(consecutiveFailures),
		})
		s.broadcastPlaybackError(bot, &next, reason, consecutiveFailures, false)
		if consecutiveFailures >= maxConsecutiveTrackFailures {
			// Something systemic is broken (missing binary, dead network,
			// wedged pipeline). Stop rather than spinning the queue, and tell
			// the users the bot gave up before the panel disappears.
			//
			// stopping is set under bot.mu first (as the idle timer does), so
			// an Enqueue that takes bot.mu from here on moves to a fresh bot
			// instead of queueing onto this one, getting 200, and having
			// stopBot clear its tracks a moment later.
			bot.mu.Lock()
			bot.stopping.Store(true)
			bot.mu.Unlock()
			s.broadcastPlaybackError(bot, &next, reason, consecutiveFailures, true)
			cleanExit = true
			s.stopBot(bot)
			return
		}
	}
}

func (s *musicBotService) prepareSeekReplay(bot *botInstance) bool {
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	bot.mu.Lock()
	defer bot.mu.Unlock()
	if !bot.seekRequested || bot.stopFlag || bot.stopping.Load() {
		return false
	}
	bot.playbackOffset = bot.seekTarget
	bot.elapsed = bot.seekTarget
	bot.startedAt = nil
	bot.isPaused = false
	bot.skipFlag = false
	bot.seekRequested = false
	return true
}

// repeatCompletedTrack runs only after a successful track. Skip must advance,
// and failures are never forced back into a loop.
func (s *musicBotService) repeatCompletedTrack(bot *botInstance, track models.MusicTrack) {
	bot.sessionMu.Lock()
	bot.mu.Lock()
	if bot.skipFlag || bot.stopFlag || bot.stopping.Load() {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	changed := false
	switch bot.repeatMode {
	case "one":
		bot.queue = append([]models.MusicTrack{track}, bot.queue...)
		bot.revision++
		changed = true
	case "all":
		bot.queue = append(bot.queue, track)
		bot.revision++
		changed = true
	}
	bot.mu.Unlock()
	if changed {
		if err := s.persistBot(bot); err != nil {
			musicBotLogger.Error("persist repeated track", "channel_id", bot.channelID, "err", pkg.ErrText(err))
			bot.mu.Lock()
			bot.queue = previousQueue
			bot.revision = previousRevision
			bot.mu.Unlock()
		}
	}
	bot.sessionMu.Unlock()
}

// loopStep is nextTrack's verdict for playLoop.
type loopStep int

const (
	loopPlay    loopStep = iota // a track was dequeued; play it
	loopStopped                 // the bot was stopped; exit without touching state
	loopDrained                 // the queue is empty; idle timer armed, exit
)

// nextTrack dequeues the next track under bot.mu. On loopStopped and
// loopDrained it clears loopRunning in the same critical section, which is
// what lets a later Enqueue start a new loop. The deferred unlock means a
// panic in here cannot leave bot.mu held for playLoop's own cleanup.
func (s *musicBotService) nextTrack(bot *botInstance) (models.MusicTrack, loopStep) {
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	bot.mu.Lock()
	if bot.stopFlag {
		bot.loopRunning = false
		bot.mu.Unlock()
		return models.MusicTrack{}, loopStopped
	}
	if len(bot.queue) == 0 {
		bot.loopRunning = false
		bot.currentTrack = nil
		bot.startedAt = nil
		bot.elapsed = 0
		bot.isPaused = false
		s.scheduleIdleLeaveLocked(bot)
		bot.mu.Unlock()
		if err := s.persistBot(bot); err != nil {
			musicBotLogger.Error("persist drained music playback state", "channel_id", bot.channelID, "err", pkg.ErrText(err))
		}
		return models.MusicTrack{}, loopDrained
	}
	next := bot.queue[0]
	bot.queue = bot.queue[1:]
	bot.revision++
	bot.currentTrack = &next
	bot.startedAt = nil // Start the clock only when audio actually reaches LiveKit.
	bot.elapsed = 0
	bot.playbackOffset = 0
	bot.isPaused = false
	bot.skipFlag = false
	bot.mu.Unlock()
	if err := s.persistBot(bot); err != nil {
		musicBotLogger.Error("persist music playback state", "channel_id", bot.channelID, "err", pkg.ErrText(err))
	}
	return next, loopPlay
}

// safePlay runs one track and turns a panic into a counted failure (reason
// "unknown") instead of letting it end playLoop: logx.Go would recover it,
// but the loop — and with it the bot — would be gone (pkg/logx/go.go: loops
// that must survive per-iteration failures wrap the iteration, not the loop).
func (s *musicBotService) safePlay(play func(*botInstance, *models.MusicTrack) error, bot *botInstance, track *models.MusicTrack) (err error) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		musicBotLogger.Error("playTrack panic recovered",
			slog.String("channel_id", bot.channelID),
			slog.String("video_id", track.VideoID),
			slog.String("panic", fmt.Sprintf("%v", r)),
			slog.String("stack", string(debug.Stack())),
		)
		err = &trackPlaybackError{Reason: reasonUnknown, err: fmt.Errorf("playTrack panic: %v", r)}
	}()
	return play(bot, track)
}

// playTrack — run the yt-dlp + ffmpeg pipeline for one track and pump
// each Opus page into the LiveKit audio track. Returns when the track ends
// (subprocess EOF), is skipped (Skip() killed the cmd), or errors.
//
// A failed track returns a *trackPlaybackError whose Reason is what clients
// are told; the error text (which may quote yt-dlp's "ERROR:" line) and both
// stderr tails are for the server log only. Skip/Stop kills return nil — they
// are not failures — including a Skip/Stop that lands before the pipeline is
// running (during the URL guard or while the subprocesses start).
func (s *musicBotService) playTrack(bot *botInstance, track *models.MusicTrack) error {
	musicBotLogger.Info("playTrack start", "channel_id", bot.channelID, "video_id", track.VideoID, "title", track.Title)

	// track.URL is NOT validated at the HTTP edge — it comes from the
	// fallback chain in music_bot_metadata.go:toTrack(), i.e. yt-dlp's own
	// JSON output (webpage_url / original_url / url), and can fall all the
	// way back to the user's raw input if none of those are present. The
	// handler only validates the URL the user originally typed, not what
	// ends up here. So this call site needs its own guard, independent of
	// extractTracks's.
	//
	// Runs on its own bounded context, checked and released before
	// bot.cancelFn is ever set: at this point the stall watchdog doesn't
	// exist yet (it's armed further down), so a guard tied to the pipeline's
	// own un-timed context could block this goroutine on a wedged DNS
	// resolver forever. Ordering it before the cancelFn assignment also
	// means a rejection here never leaves bot.cancelFn pointing at a
	// pipeline that was never started.
	guardCtx, guardCancel := context.WithTimeout(context.Background(), 5*time.Second)
	guardErr := validateMusicURLNetwork(guardCtx, track.URL)
	// Read before guardCancel, which would turn the context's error into
	// Canceled.
	guardTimedOut := errors.Is(guardCtx.Err(), context.DeadlineExceeded)
	guardCancel()

	// A Skip or Stop that landed during the guard (up to 5 s of DNS) had
	// nothing to kill: bot.cmd and bot.cancelFn are not set yet. Honour it
	// here, whatever the guard said — otherwise a skipped track plays to its
	// end, and a stopped bot reports a failure for a track nobody wants.
	//
	// The audio track is snapshotted in the same critical section (stopBot
	// clears it): a nil track seen here can then never be a Stop, which is
	// already reported as endedEarly. The nil check is on the concrete
	// pointer: once converted to the sampleWriter interface a nil
	// *LocalSampleTrack is a non-nil interface value, and WriteSample on it
	// panics.
	bot.mu.Lock()
	endedEarly := bot.killRequestedLocked()
	audio := bot.audioTrack
	room := bot.lkRoom
	bot.mu.Unlock()
	if endedEarly {
		musicBotLogger.Info("playTrack: skipped or stopped before the pipeline started",
			"channel_id", bot.channelID, "video_id", track.VideoID)
		return nil
	}
	if guardErr != nil {
		if guardTimedOut {
			// The guard reports a resolver timeout as its generic "DNS
			// lookup failed" bad request. Keep the deadline in the chain so
			// the track is classified as a network failure, not "unknown".
			return fmt.Errorf("%w (%w)", guardErr, context.DeadlineExceeded)
		}
		return guardErr
	}
	if audio == nil {
		return &trackPlaybackError{Reason: reasonUnknown, err: errBotNotConnected}
	}
	var sink sampleWriter = audio

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bot.mu.Lock()
	bot.cancelFn = cancel
	bot.mu.Unlock()
	// Deferred before the reaper below, so it runs after it.
	defer func() {
		bot.mu.Lock()
		bot.cmd = nil
		bot.cancelFn = nil
		bot.isPaused = false
		bot.mu.Unlock()
	}()

	// endedOnPurpose tells a start failure caused by Skip/Stop apart from a
	// broken tool. stopBot's cancelFn makes CommandContext's Start fail with
	// the context error, which must not be reported as tool_missing: a
	// Skip/Stop-initiated kill is not a failure. Until the pipeline runs,
	// only stopBot cancels ctx (the stall watchdog is armed later).
	endedOnPurpose := func() bool {
		if ctx.Err() != nil {
			return true
		}
		bot.mu.Lock()
		defer bot.mu.Unlock()
		return bot.killRequestedLocked()
	}

	// yt-dlp pipes raw audio to stdout; ffmpeg consumes it and emits Ogg/Opus.
	// `-re` makes ffmpeg pace its output to real-time, so our blocking reads
	// downstream are naturally rate-limited at ~50 frames/second (20 ms each).
	//
	// `--` terminates yt-dlp option parsing — `track.URL` originates from the
	// fallback chain in music_bot_metadata.go:toTrack(), which can land on
	// the user's raw input if yt-dlp didn't return a webpage URL. Without
	// the terminator a crafted URL would let the dequeue path inherit the
	// same argument-injection risk fixed in extractTracks.
	ytBin, err := ytDlpPath()
	if err != nil {
		if endedOnPurpose() {
			return nil
		}
		return fmt.Errorf("%w: yt-dlp not available: %w", errToolMissing, err)
	}
	bot.mu.Lock()
	seekOffset := bot.playbackOffset
	bot.mu.Unlock()
	yt := exec.CommandContext(ctx, ytBin, playTrackYtdlpArgs(track.URL, seekOffset)...) // #nosec G204 -- fixed argv; ytBin is an absolute path resolved once by ytDlpPath (see music_bot_metadata.go); track.URL passes validateMusicURLNetwork above (host allow-list + post-DNS private/reserved-IP check, see music_url_guard.go) and is isolated behind `--` in playTrackYtdlpArgs
	ffBin, err := ffmpegPath()
	if err != nil {
		if endedOnPurpose() {
			return nil
		}
		return fmt.Errorf("%w: ffmpeg not available: %w", errToolMissing, err)
	}
	ff := exec.CommandContext(ctx, ffBin, playTrackFFmpegArgs()...)

	// stderr goes into bounded tail buffers: yt-dlp prints the reason a
	// track failed (HTTP 403, bot check, ...) there and nowhere else. The
	// tails feed classifyPlaybackFailure and the failure log line. Because
	// a non-*os.File Stderr makes exec copy it from a goroutine that Wait
	// waits for, WaitDelay bounds that wait in case a pipe is held open.
	ytTail := newTailBuffer(ytDlpStderrTailBytes)
	ffTail := newTailBuffer(ffmpegStderrTailBytes)
	yt.Stderr = ytTail
	ff.Stderr = ffTail
	yt.WaitDelay = subprocessWaitDelay
	ff.WaitDelay = subprocessWaitDelay

	ytOut, err := yt.StdoutPipe()
	if err != nil {
		musicBotLogger.Error("playTrack: yt-dlp stdout pipe failed", "err", pkg.ErrText(err))
		return fmt.Errorf("yt-dlp pipe: %w", err)
	}
	ff.Stdin = ytOut

	ffOut, err := ff.StdoutPipe()
	if err != nil {
		musicBotLogger.Error("playTrack: ffmpeg stdout pipe failed", "err", pkg.ErrText(err))
		return fmt.Errorf("ffmpeg pipe: %w", err)
	}

	if err := ff.Start(); err != nil {
		if endedOnPurpose() {
			musicBotLogger.Info("playTrack: ffmpeg start interrupted by skip/stop", "channel_id", bot.channelID, "err", pkg.ErrText(err))
			return nil
		}
		musicBotLogger.Error("playTrack: ffmpeg start failed (binary missing in PATH?)", "err", pkg.ErrText(err))
		return fmt.Errorf("%w: ffmpeg start: %w", errToolMissing, err)
	}
	// ffmpeg now holds its own copy of the pipe's read end. Drop ours, or
	// yt-dlp never sees EPIPE when ffmpeg dies (Skip kills only ffmpeg) and
	// sits blocked on a full pipe until the reaper's grace period kills it.
	// yt.Wait closes this again later; that second close is a no-op error.
	_ = ytOut.Close()
	if err := yt.Start(); err != nil {
		_ = ff.Process.Kill()
		_ = ff.Wait()
		if endedOnPurpose() {
			musicBotLogger.Info("playTrack: yt-dlp start interrupted by skip/stop", "channel_id", bot.channelID, "err", pkg.ErrText(err))
			return nil
		}
		musicBotLogger.Error("playTrack: yt-dlp start failed (binary missing in PATH?)", "err", pkg.ErrText(err))
		return fmt.Errorf("%w: yt-dlp start: %w", errToolMissing, err)
	}
	musicBotLogger.Info("playTrack: pipeline started", "ytdlp_pid", yt.Process.Pid, "ffmpeg_pid", ff.Process.Pid)

	bot.mu.Lock()
	bot.cmd = ff // ffmpeg holds the pipeline; killing it cascades to yt-dlp via EOF
	if bot.killRequestedLocked() {
		// Skip/Stop landed while the pipeline was starting, when Skip had no
		// cmd to kill. Kill it now: the pump sees EOF, and the skipped/
		// stopped check after it returns nil.
		_ = ff.Process.Kill()
	}
	bot.mu.Unlock()

	// Reaper. Runs once: explicitly with a grace period after the pump
	// returns, or from the defer with none. The grace path lets both
	// processes exit on their own first, so ytErr is yt-dlp's real exit
	// status (e.g. exit 1 after a 403) rather than the kill cancel() would
	// cause. The deferred path — a panic, or any return that skipped the
	// explicit call — cancels first and only then waits: waiting first
	// would block forever on a pipeline nobody is reading any more.
	var (
		reapOnce     sync.Once
		ytErr, ffErr error
	)
	reap := func(grace time.Duration) {
		reapOnce.Do(func() {
			if grace <= 0 {
				cancel()
			}
			done := make(chan struct{})
			logx.Go("service.music_bot.reap", func() {
				defer close(done)
				ytErr = yt.Wait()
				ffErr = ff.Wait()
			})
			if grace > 0 {
				select {
				case <-done:
					return
				case <-time.After(grace):
					cancel()
				}
			}
			<-done
		})
	}
	defer reap(0)

	// Stall watchdog. Without it, a hung yt-dlp that neither writes nor exits
	// leaves pumpOggToTrack blocked on a read forever, so the reaper never
	// runs and both subprocesses and this goroutine leak until someone calls
	// Skip/Stop. Cancelling the track context makes CommandContext kill the
	// pair, which returns the read.
	stallTimeout, stallPoll := s.stallThresholds()
	// A paused pump emits nothing by design; isPaused keeps the
	// watchdog from reading that as a wedge.
	isPaused := func() bool {
		bot.mu.Lock()
		defer bot.mu.Unlock()
		return bot.isPaused
	}
	watchdog := newStallWatchdog(ctx, cancel, stallTimeout, stallPoll, bot.channelID, isPaused)
	defer watchdog.close()

	controller := &musicSampleController{
		ctx: ctx, bot: bot, sink: sink, onStart: func() { s.broadcastState(bot) },
		ready: func() bool {
			if !audio.IsBound() || room == nil || room.ConnectionState() != lksdk.ConnectionStateConnected {
				return false
			}
			// Room signaling can connect before the publishing transport is
			// ready. The SDK silently drops samples in that interval.
			publisher := room.LocalParticipant.GetPublisherPeerConnection()
			return publisher != nil && publisher.ConnectionState() == webrtc.PeerConnectionStateConnected
		},
	}
	pumpErr := pumpOggToTrack(ffOut, controller, watchdog.progress)

	bot.mu.Lock()
	killRequested := bot.killRequestedLocked()
	bot.mu.Unlock()
	if killRequested {
		// Skip/Stop: the exit status is irrelevant, so don't hold the next
		// track for the grace period.
		reap(0)
	} else {
		reap(playTrackReapGrace)
	}

	bot.mu.Lock()
	skipped := bot.skipFlag
	stopped := bot.stopFlag || bot.stopping.Load()
	bot.mu.Unlock()
	if skipped || stopped {
		// Killed on purpose — not a playback failure.
		return nil
	}

	ytStderr := ytTail.String()
	var failErr *trackPlaybackError
	switch {
	case watchdog.stalled():
		// Killing the subprocess usually surfaces as a clean EOF, so without
		// this the caller would count a wedged track as a successful one and
		// the consecutive-failure cap would never trip.
		failErr = &trackPlaybackError{
			Reason: reasonStalled,
			err:    fmt.Errorf("%w: no audio progress for %s", errPlaybackStalled, stallTimeout),
		}
	case pumpErr != nil || ytErr != nil || ffErr != nil:
		cause := pumpErr
		if pumpErr == nil && ytErr != nil {
			cause = fmt.Errorf("yt-dlp exit: %w", ytErr)
		} else if ytErr != nil {
			cause = fmt.Errorf("%w; yt-dlp exit: %w", pumpErr, ytErr)
		}
		if ffErr != nil {
			cause = errors.Join(cause, fmt.Errorf("ffmpeg exit: %w", ffErr))
		}
		reason := classifyPlaybackFailure(cause, ytStderr)
		// yt-dlp's own "ERROR:" line is the useful part of the server-side
		// error (the pump only sees "oggreader init: EOF"). Quoted because
		// it is subprocess output.
		if line := lastYtDlpErrorLine(ytStderr); line != "" {
			cause = fmt.Errorf("yt-dlp: %s: %w", strconv.Quote(truncateRunes(line, maxPlaybackErrorLineLen)), cause)
		}
		failErr = &trackPlaybackError{Reason: reason, err: cause}
	default:
		return nil
	}

	// Server-side only. Subprocess output is tainted, hence strconv.Quote.
	musicBotLogger.Warn("playTrack failed",
		slog.String("channel_id", bot.channelID),
		slog.String("video_id", track.VideoID),
		slog.String("reason", string(failErr.Reason)),
		slog.String("err", pkg.ErrText(failErr)),
		slog.String("yt_stderr_tail", strconv.Quote(ytStderr)),
		slog.String("ff_stderr_tail", strconv.Quote(ffTail.String())),
		slog.String("yt_exit", pkg.ErrText(ytErr)),
		slog.String("ff_exit", pkg.ErrText(ffErr)),
	)
	return failErr
}

// killRequestedLocked reports whether Skip, Seek, or a stop has asked the
// current pipeline to end. Caller holds bot.mu.
func (b *botInstance) killRequestedLocked() bool {
	return b.skipFlag || b.seekRequested || b.stopFlag || b.stopping.Load()
}

// playTrackYtdlpArgs builds playTrack's yt-dlp argv. Factored out (rather
// than inlined at the exec.CommandContext call) so a test can assert
// "--use-extractors Youtube.*" is actually present without spawning the
// subprocess — see TestPlayTrackYtdlpArgs_RestrictsToYoutubeExtractors.
// "--use-extractors" mirrors extractTracksArgs in music_bot_metadata.go —
// see that file's comment for why GenericIE must stay disabled here too.
//
// "bestaudio/best" falls back to a combined format when a video offers no
// audio-only one (ffmpeg drops the video stream with -vn). There is no
// --no-warnings: yt-dlp's warnings land in playTrack's stderr tail, which is
// only logged, and they often explain the ERROR that follows.
func playTrackYtdlpArgs(url string, seekOffset time.Duration) []string {
	args := []string{
		"--ignore-config", "--no-plugin-dirs", "--no-remote-components",
		"--no-playlist", "--no-progress",
		"-f", "bestaudio/best",
		"--use-extractors", "Youtube.*",
	}
	if seekOffset > 0 {
		args = append(args, "--download-sections", fmt.Sprintf("*%d-inf", int(seekOffset/time.Second)))
	}
	return append(args, "-o", "-", "--", url)
}

// -re is an INPUT option: after -i FFmpeg rejects the entire command.
// The sample controller also paces output so resuming after backpressure
// cannot send a burst when FFmpeg tries to catch up with its input clock.
func playTrackFFmpegArgs() []string {
	return []string{
		"-hide_banner", "-loglevel", "warning", "-nostdin",
		"-re", "-i", "pipe:0", "-vn", "-ac", "2", "-ar", "48000",
		"-c:a", "libopus", "-b:a", "128k", "-application", "audio",
		"-frame_duration", "20", "-page_duration", "20000", "-f", "ogg", "pipe:1",
	}
}

// stallThresholds returns the live watchdog timings — the consts above unless
// a test shrank them on the service instance.
func (s *musicBotService) stallThresholds() (timeout, poll time.Duration) {
	timeout, poll = trackStallTimeout, trackStallPollInterval
	if s.stallTimeoutOverride > 0 {
		timeout = s.stallTimeoutOverride
	}
	if s.stallPollOverride > 0 {
		poll = s.stallPollOverride
	}
	return timeout, poll
}

// stallWatchdog cancels a track's context when the pipeline stops making
// progress. Progress is a unix-nano timestamp bumped per Ogg page, so the
// check is a cheap atomic load off the audio path.
type stallWatchdog struct {
	last  atomic.Int64
	fired atomic.Bool
	stop  chan struct{}
	done  chan struct{}
}

// newStallWatchdog arms the watchdog and starts its ticker goroutine. Progress
// is seeded at arm time, so a pipeline that never emits a single page — the
// common yt-dlp wedge — is caught by the same timeout. While paused (nil
// means never) reports true, each tick counts as progress, so a pause of any
// length never fires it and Resume starts from a fresh timeout.
func newStallWatchdog(ctx context.Context, cancel context.CancelFunc, timeout, poll time.Duration, channelID string, paused func() bool) *stallWatchdog {
	w := &stallWatchdog{stop: make(chan struct{}), done: make(chan struct{})}
	w.last.Store(time.Now().UnixNano())

	go func() {
		defer close(w.done)
		ticker := time.NewTicker(poll)
		defer ticker.Stop()
		for {
			select {
			case <-w.stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if paused != nil && paused() {
					w.progress()
					continue
				}
				if time.Since(time.Unix(0, w.last.Load())) < timeout {
					continue
				}
				// Order matters: mark first, then cancel. playTrack reads
				// stalled() only after the cancel has unblocked its read.
				w.fired.Store(true)
				musicBotLogger.Warn("stall watchdog: no audio progress, killing pipeline", "timeout", timeout, "channel_id", channelID)
				cancel()
				return
			}
		}
	}()
	return w
}

// progress records that the pipeline is still producing audio.
func (w *stallWatchdog) progress() { w.last.Store(time.Now().UnixNano()) }

// stalled reports whether the watchdog cancelled the track.
func (w *stallWatchdog) stalled() bool { return w.fired.Load() }

// close halts the ticker and waits for the goroutine to exit.
func (w *stallWatchdog) close() {
	close(w.stop)
	<-w.done
}

// sampleWriter is the subset of *lksdk.LocalSampleTrack that pumpOggToTrack
// needs, declared as an interface so the Ogg loop is unit-testable without a
// LiveKit connection.
type sampleWriter interface {
	WriteSample(sample media.Sample, opts *lksdk.SampleWriteOptions) error
}

// pumpOggToTrack — read Ogg/Opus pages off ffmpeg's stdout, write each as a
// 20 ms Opus sample to the LiveKit track. Returns nil on clean EOF, error
// on parse / write failure.
//
// onPage (nil-safe) fires once per successfully parsed page; playTrack wires
// it to the stall watchdog so a wedged pipeline can be detected from outside
// this blocking loop.
//
// Assumes ffmpeg's Ogg muxer is configured (`-page_duration 20000`) so each
// Ogg page contains exactly one Opus packet. Pion's oggreader returns the
// page payload — for single-packet pages this is one Opus frame.
func pumpOggToTrack(reader io.Reader, track sampleWriter, onPage func()) error {
	ogg, _, err := oggreader.NewWith(reader)
	if err != nil {
		musicBotLogger.Error("pumpOggToTrack: oggreader init failed", "err", pkg.ErrText(err))
		return fmt.Errorf("oggreader init: %w", err)
	}
	const frameDuration = 20 * time.Millisecond
	samplesWritten := 0
	for {
		page, _, perr := ogg.ParseNextPage()
		if errors.Is(perr, io.EOF) {
			if samplesWritten == 0 {
				return errors.New("audio stream ended without any Opus samples")
			}
			musicBotLogger.Info("pumpOggToTrack: clean EOF", "samples_written", samplesWritten)
			return nil
		}
		if perr != nil {
			musicBotLogger.Error("pumpOggToTrack: ogg parse error", "samples_written", samplesWritten, "err", pkg.ErrText(perr))
			return fmt.Errorf("ogg parse: %w", perr)
		}
		// A parsed page is proof the pipeline is alive, even an empty one.
		if onPage != nil {
			onPage()
		}
		// NewWith consumes OpusHead, but the next page is OpusTags, not
		// encoded audio. Publishing it creates an invalid RTP Opus packet.
		if len(page) == 0 || bytes.HasPrefix(page, []byte("OpusTags")) || bytes.HasPrefix(page, []byte("OpusHead")) {
			continue
		}
		if werr := track.WriteSample(media.Sample{Data: page, Duration: frameDuration}, nil); werr != nil {
			if errors.Is(werr, context.Canceled) {
				return werr
			}
			musicBotLogger.Error("pumpOggToTrack: WriteSample failed", "samples_written", samplesWritten, "err", pkg.ErrText(werr))
			return fmt.Errorf("write sample: %w", werr)
		}
		samplesWritten++
		if samplesWritten == 1 {
			// One-shot log so we know the audio path actually started — silence
			// here = pipeline broken between ffmpeg stdout and the LK track.
			musicBotLogger.Info("pumpOggToTrack: first sample written successfully")
		}
	}
}

// scheduleIdleLeaveLocked — caller holds bot.mu. Arms a one-shot timer that
// stops THIS bot (stopBot, not the channel-keyed Stop, which could hit a
// newer bot in the same channel) if it is still idle when the timer fires.
// Enqueue cancels the timer before appending, but a callback that has
// already started cannot be recalled, so the callback re-checks under
// bot.mu: a changed idleGen (the timer was cancelled or re-armed), a running
// loop, queued tracks, or an earlier stop all mean "not idle any more".
// stopping is set inside that same critical section, so an Enqueue that
// takes bot.mu afterwards sees it and moves to a fresh bot.
func (s *musicBotService) scheduleIdleLeaveLocked(bot *botInstance) {
	bot.cancelIdleTimer()
	gen := bot.idleGen
	bot.idleTimer = time.AfterFunc(s.idleLeaveDelay(), func() {
		bot.mu.Lock()
		if gen != bot.idleGen || bot.loopRunning || len(bot.queue) > 0 || bot.stopFlag {
			bot.mu.Unlock()
			return
		}
		bot.stopping.Store(true)
		bot.mu.Unlock()
		musicBotLogger.Info("idle leave", "channel_id", bot.channelID)
		s.stopBot(bot)
	})
}

// idleLeaveDelay returns idleLeaveAfter unless a test shrank it.
func (s *musicBotService) idleLeaveDelay() time.Duration {
	if s.idleLeaveOverride > 0 {
		return s.idleLeaveOverride
	}
	return idleLeaveAfter
}
