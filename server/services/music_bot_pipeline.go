package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"

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
	room, err := lksdk.ConnectToRoomWithToken(lkInstance.URL, token, &lksdk.RoomCallback{
		OnDisconnected: func() {
			musicBotLogger.Info("bot disconnected", "channel_id", bot.channelID)
		},
	})
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: livekit dial failed", "url", lkInstance.URL, "err", pkg.ErrText(err))
		return fmt.Errorf("livekit connect: %w", err)
	}
	musicBotLogger.Info("connectBotToRoom: livekit connected", "room", bot.roomName)

	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	})
	if err != nil {
		room.Disconnect()
		musicBotLogger.Error("connectBotToRoom: track create failed", "err", pkg.ErrText(err))
		return fmt.Errorf("track create: %w", err)
	}

	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "music",
		Source: livekitproto.TrackSource_MICROPHONE,
	})
	if err != nil {
		room.Disconnect()
		musicBotLogger.Error("connectBotToRoom: publish track failed", "err", pkg.ErrText(err))
		return fmt.Errorf("publish track: %w", err)
	}

	bot.lkRoom = room
	bot.audioTrack = track
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
)

// playLoop — the per-bot driver goroutine. Dequeues tracks one at a time and
// drives the yt-dlp → ffmpeg → Opus → LiveKit pipeline for each. When the
// queue empties, schedules an idle-leave timer; another Enqueue arriving
// before the timer fires cancels it and restarts the loop.
//
// Exits when:
//   - bot.stopFlag is set (Stop() was called) — bot already disconnected
//   - the queue drains (idle-leave timer armed)
//   - maxConsecutiveTrackFailures tracks fail back to back
func (s *musicBotService) playLoop(bot *botInstance) {
	// Seam for tests (mirrors BackupService.runCmd): production runs the real
	// subprocess pipeline, tests substitute a stub so the loop's control flow
	// can be exercised without yt-dlp/ffmpeg.
	play := s.playTrackFn
	if play == nil {
		play = s.playTrack
	}

	consecutiveFailures := 0
	for {
		bot.mu.Lock()
		if bot.stopFlag {
			bot.mu.Unlock()
			return
		}
		if len(bot.queue) == 0 {
			bot.currentTrack = nil
			bot.startedAt = nil
			s.scheduleIdleLeaveLocked(bot)
			bot.mu.Unlock()
			s.broadcastState(bot)
			return
		}
		next := bot.queue[0]
		bot.queue = bot.queue[1:]
		bot.currentTrack = &next
		now := time.Now()
		bot.startedAt = &now
		bot.skipFlag = false
		bot.mu.Unlock()

		s.broadcastState(bot)

		err := play(bot, &next)
		if err == nil {
			// Only CONSECUTIVE failures count — one good track means the
			// pipeline works and the earlier errors were per-video duds.
			consecutiveFailures = 0
			continue
		}

		consecutiveFailures++
		s.logErr(models.LogCategoryVoice, bot.channelID, "music playback failed", map[string]string{
			"video_id":             next.VideoID,
			"error":                err.Error(),
			"consecutive_failures": strconv.Itoa(consecutiveFailures),
		})
		if consecutiveFailures >= maxConsecutiveTrackFailures {
			// Something systemic is broken (missing binary, dead network,
			// wedged pipeline). Stop rather than spinning the queue, and tell
			// the users why before the panel disappears.
			s.broadcastPlaybackError(bot, err, consecutiveFailures)
			_ = s.Stop(bot.channelID)
			return
		}
	}
}

// playTrack — run the yt-dlp + ffmpeg pipeline for one track and pump
// each Opus page into the LiveKit audio track. Returns when the track ends
// (subprocess EOF), is skipped (Skip() killed the cmd), or errors.
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
	guardCancel()
	if guardErr != nil {
		return guardErr
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bot.mu.Lock()
	bot.cancelFn = cancel
	bot.mu.Unlock()

	// yt-dlp pipes raw audio to stdout; ffmpeg consumes it and emits Ogg/Opus.
	// `-re` makes ffmpeg pace its output to real-time, so our blocking reads
	// downstream are naturally rate-limited at ~50 frames/second (20 ms each).
	//
	// `--` terminates yt-dlp option parsing — `track.URL` originates from the
	// fallback chain in music_bot_metadata.go:toTrack(), which can land on
	// the user's raw input if yt-dlp didn't return a webpage URL. Without
	// the terminator a crafted URL would let the dequeue path inherit the
	// same argument-injection risk fixed in extractTracks.
	yt := exec.CommandContext(ctx, "yt-dlp", playTrackYtdlpArgs(track.URL)...) // #nosec G204 -- fixed argv; track.URL passes validateMusicURLNetwork above (host allow-list + post-DNS private/reserved-IP check, see music_url_guard.go) and is isolated behind `--` in playTrackYtdlpArgs
	ff := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "warning",
		"-i", "pipe:0",
		"-vn",
		"-re",
		"-ac", "2",
		"-ar", "48000",
		"-c:a", "libopus",
		"-b:a", "64k",
		"-application", "audio",
		"-frame_duration", "20",
		"-page_duration", "20000",
		"-f", "ogg",
		"pipe:1",
	)

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
		musicBotLogger.Error("playTrack: ffmpeg start failed (binary missing in PATH?)", "err", pkg.ErrText(err))
		return fmt.Errorf("ffmpeg start: %w", err)
	}
	if err := yt.Start(); err != nil {
		musicBotLogger.Error("playTrack: yt-dlp start failed (binary missing in PATH?)", "err", pkg.ErrText(err))
		_ = ff.Process.Kill()
		return fmt.Errorf("yt-dlp start: %w", err)
	}
	musicBotLogger.Info("playTrack: pipeline started", "ytdlp_pid", yt.Process.Pid, "ffmpeg_pid", ff.Process.Pid)

	bot.mu.Lock()
	bot.cmd = ff // ffmpeg holds the pipeline; killing it cascades to yt-dlp via EOF
	bot.mu.Unlock()

	defer func() {
		bot.mu.Lock()
		bot.cmd = nil
		bot.cancelFn = nil
		bot.isPaused = false
		bot.mu.Unlock()
		_ = yt.Wait() // reap zombie
		_ = ff.Wait()
	}()

	// Stall watchdog. Without it, a hung yt-dlp that neither writes nor exits
	// leaves pumpOggToTrack blocked on a read forever: the deferred Wait()s
	// above never run, so both subprocesses and this goroutine leak until
	// someone calls Skip/Stop. Cancelling the track context makes
	// CommandContext kill the pair, which returns the read and runs the defers.
	stallTimeout, stallPoll := s.stallThresholds()
	watchdog := newStallWatchdog(ctx, cancel, stallTimeout, stallPoll, bot.channelID)
	defer watchdog.close()

	pumpErr := pumpOggToTrack(ffOut, bot.audioTrack, watchdog.progress)

	bot.mu.Lock()
	skipped := bot.skipFlag
	stopped := bot.stopFlag
	bot.mu.Unlock()
	if skipped || stopped {
		// Killed on purpose — not a playback failure.
		return nil
	}
	if watchdog.stalled() {
		// Killing the subprocess usually surfaces as a clean EOF, so without
		// this the caller would count a wedged track as a successful one and
		// the consecutive-failure cap would never trip.
		return fmt.Errorf("playback stalled: no audio progress for %s", stallTimeout)
	}
	return pumpErr
}

// playTrackYtdlpArgs builds playTrack's yt-dlp argv. Factored out (rather
// than inlined at the exec.CommandContext call) so a test can assert
// "--use-extractors Youtube.*" is actually present without spawning the
// subprocess — see TestPlayTrackYtdlpArgs_RestrictsToYoutubeExtractors.
// "--use-extractors" mirrors extractTracksArgs in music_bot_metadata.go —
// see that file's comment for why GenericIE must stay disabled here too.
func playTrackYtdlpArgs(url string) []string {
	return []string{
		"-f", "bestaudio",
		"--no-warnings",
		"--use-extractors", "Youtube.*",
		"-o", "-",
		"--",
		url,
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
// common yt-dlp wedge — is caught by the same timeout.
func newStallWatchdog(ctx context.Context, cancel context.CancelFunc, timeout, poll time.Duration, channelID string) *stallWatchdog {
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
		if len(page) == 0 {
			continue
		}
		if werr := track.WriteSample(media.Sample{Data: page, Duration: frameDuration}, nil); werr != nil {
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
// calls Stop() if no track has been enqueued by then. Re-arming is handled
// by Enqueue cancelling the existing timer before appending.
func (s *musicBotService) scheduleIdleLeaveLocked(bot *botInstance) {
	bot.cancelIdleTimer()
	bot.idleTimer = time.AfterFunc(idleLeaveAfter, func() {
		musicBotLogger.Info("idle leave", "channel_id", bot.channelID)
		_ = s.Stop(bot.channelID)
	})
}
