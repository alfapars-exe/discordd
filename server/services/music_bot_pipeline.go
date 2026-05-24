package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
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
	log.Printf("[music] connectBotToRoom: starting channel=%s server=%s", bot.channelID, bot.serverID)
	lkInstance, err := s.livekit.GetByServerID(ctx, bot.serverID)
	if err != nil {
		log.Printf("[music] connectBotToRoom: livekit instance lookup failed server=%s err=%v", bot.serverID, err)
		return fmt.Errorf("livekit instance lookup: %w", err)
	}
	log.Printf("[music] connectBotToRoom: livekit instance resolved url=%s self_hosted=%v",
		lkInstance.URL, !lkInstance.IsPlatformManaged)

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		log.Printf("[music] connectBotToRoom: api key decrypt failed instance=%s err=%v", lkInstance.ID, err)
		return fmt.Errorf("api key decrypt: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		log.Printf("[music] connectBotToRoom: api secret decrypt failed instance=%s err=%v", lkInstance.ID, err)
		return fmt.Errorf("api secret decrypt: %w", err)
	}

	canPublish := true
	canSubscribe := true
	canPublishData := false

	at := auth.NewAccessToken(apiKey, apiSecret)
	at.AddGrant(&auth.VideoGrant{
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

	log.Printf("[music] connectBotToRoom: dialing livekit url=%s room=%s", lkInstance.URL, bot.roomName)
	room, err := lksdk.ConnectToRoomWithToken(lkInstance.URL, token, &lksdk.RoomCallback{
		OnDisconnected: func() {
			log.Printf("[music] bot disconnected channel=%s", bot.channelID)
		},
	})
	if err != nil {
		log.Printf("[music] connectBotToRoom: livekit dial failed url=%s err=%v", lkInstance.URL, err)
		return fmt.Errorf("livekit connect: %w", err)
	}
	log.Printf("[music] connectBotToRoom: livekit connected room=%s", bot.roomName)

	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	})
	if err != nil {
		room.Disconnect()
		log.Printf("[music] connectBotToRoom: track create failed err=%v", err)
		return fmt.Errorf("track create: %w", err)
	}

	pub, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "music",
		Source: livekitproto.TrackSource_MICROPHONE,
	})
	if err != nil {
		room.Disconnect()
		log.Printf("[music] connectBotToRoom: publish track failed err=%v", err)
		return fmt.Errorf("publish track: %w", err)
	}

	bot.lkRoom = room
	bot.audioTrack = track
	log.Printf("[music] bot joined room=%s identity=%s:%s pub_sid=%s",
		bot.roomName, models.MusicBotUserID, bot.channelID, pub.SID())
	return nil
}

// playLoop — the per-bot driver goroutine. Dequeues tracks one at a time and
// drives the yt-dlp → ffmpeg → Opus → LiveKit pipeline for each. When the
// queue empties, schedules an idle-leave timer; another Enqueue arriving
// before the timer fires cancels it and restarts the loop.
//
// Exits when:
//   - bot.stopFlag is set (Stop() was called) — bot already disconnected
//   - context cancelled
//   - playTrack returns an unrecoverable error AND queue is empty
func (s *musicBotService) playLoop(bot *botInstance) {
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

		if err := s.playTrack(bot, &next); err != nil {
			s.logErr(models.LogCategoryVoice, bot.channelID, "music playback failed", map[string]string{
				"video_id": next.VideoID, "error": err.Error(),
			})
			// Tell every listener what failed and why. Otherwise the bot
			// silently skips the track and users see "queued" with no audio.
			s.broadcastPlaybackError(bot, &next, err.Error())
			// Continue to next track regardless of single-track error.
		}
	}
}

// playTrack — run the yt-dlp + ffmpeg pipeline for one track and pump
// each Opus page into the LiveKit audio track. Returns when the track ends
// (subprocess EOF), is skipped (Skip() killed the cmd), or errors.
func (s *musicBotService) playTrack(bot *botInstance, track *models.MusicTrack) error {
	log.Printf("[music] playTrack start: channel=%s video=%s title=%q",
		bot.channelID, track.VideoID, track.Title)

	ctx, cancel := context.WithCancel(context.Background())
	// Defensive: covers the early-return paths below (pipe setup, Start())
	// where the cleanup defer hasn't been pushed yet. On the happy path the
	// cleanup defer calls cancel() first; this second call is a no-op.
	defer cancel()

	bot.mu.Lock()
	bot.cancelFn = cancel
	bot.mu.Unlock()

	// yt-dlp pipes raw audio to stdout; ffmpeg consumes it and emits Ogg/Opus.
	// `-re` makes ffmpeg pace its output to real-time, so our blocking reads
	// downstream are naturally rate-limited at ~50 frames/second (20 ms each).
	//
	// Flag rationale:
	//   -f bestaudio/best   — fall back to combined a/v if bestaudio missing
	//                         (some videos only expose merged formats now)
	//   --geo-bypass        — pretend to be in the video's home region;
	//                         helps for region-locked Turkish artists when
	//                         the server runs on a non-TR cloud IP
	//   --no-playlist       — defense-in-depth; if a stray list= param
	//                         survived normalizeYouTubeURL, don't enumerate
	//   --no-warnings       — keep stderr clean for our diagnostic capture
	ytArgs := []string{
		"-f", "bestaudio/best",
		"--no-warnings",
		"--no-playlist",
		"--geo-bypass",
		// Mobile-first client probe + matching mobile UA — see the
		// constants in music_bot_metadata.go. YouTube bot-detects the
		// default desktop client on data-center IPs; mobile flows
		// sometimes slip through.
		"--extractor-args", ytdlpExtractorArgs,
		"--user-agent", ytdlpUserAgent,
	}
	// Optional cookies jar — see ytdlpAuthFlags() in metadata.go. When
	// the bot-challenge fires, the metadata fetch already failed earlier,
	// so this is mostly a safety net for the rarer case where extraction
	// works (cached metadata) but the stream URL hand-off requires auth.
	ytArgs = append(ytArgs, ytdlpAuthFlags()...)
	ytArgs = append(ytArgs, "-o", "-", track.URL)
	yt := exec.CommandContext(ctx, "yt-dlp", ytArgs...)
	// Capture yt-dlp's stderr so a failure (region lock, sign-in required,
	// 410 stream URL expired) shows up in the playback_error broadcast
	// instead of being lost to /dev/null. The buffer is bounded by the
	// process lifetime; YouTube's worst-case errors are ~2 KB.
	var ytErrBuf bytes.Buffer
	yt.Stderr = &ytErrBuf

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
	// Capture ffmpeg's stderr too — codec errors (e.g., "Invalid data
	// found when processing input" when yt-dlp produced nothing) surface
	// here and need to reach the user toast same way.
	var ffErrBuf bytes.Buffer
	ff.Stderr = &ffErrBuf

	ytOut, err := yt.StdoutPipe()
	if err != nil {
		log.Printf("[music] playTrack: yt-dlp stdout pipe failed err=%v", err)
		return fmt.Errorf("yt-dlp pipe: %w", err)
	}
	ff.Stdin = ytOut

	ffOut, err := ff.StdoutPipe()
	if err != nil {
		log.Printf("[music] playTrack: ffmpeg stdout pipe failed err=%v", err)
		return fmt.Errorf("ffmpeg pipe: %w", err)
	}

	if err := ff.Start(); err != nil {
		log.Printf("[music] playTrack: ffmpeg start failed (binary missing in PATH?) err=%v", err)
		return fmt.Errorf("ffmpeg start: %w", err)
	}
	if err := yt.Start(); err != nil {
		log.Printf("[music] playTrack: yt-dlp start failed (binary missing in PATH?) err=%v", err)
		_ = ff.Process.Kill()
		return fmt.Errorf("yt-dlp start: %w", err)
	}
	log.Printf("[music] playTrack: pipeline started ytdlp_pid=%d ffmpeg_pid=%d",
		yt.Process.Pid, ff.Process.Pid)

	bot.mu.Lock()
	bot.cmd = ff // ffmpeg holds the pipeline; killing it cascades to yt-dlp via EOF
	bot.mu.Unlock()

	defer func() {
		// Kill the pipeline subprocesses BEFORE waiting. exec.CommandContext
		// kills the process when ctx is cancelled, which unblocks Wait().
		// Without this, an early return from pumpOggToTrack (ogg parse error
		// or WriteSample failure mid-track) would block here for the entire
		// natural duration of the song while yt-dlp/ffmpeg run uselessly.
		cancel()
		bot.mu.Lock()
		bot.cmd = nil
		bot.cancelFn = nil
		bot.isPaused = false
		bot.mu.Unlock()
		_ = yt.Wait() // reap zombie
		_ = ff.Wait()
	}()

	if err := pumpOggToTrack(ffOut, bot.audioTrack); err != nil {
		bot.mu.Lock()
		skipped := bot.skipFlag
		stopped := bot.stopFlag
		bot.mu.Unlock()
		if skipped || stopped {
			return nil
		}
		// Snapshot whatever stderr the subprocesses already flushed and
		// enrich the error with the upstream message — yt-dlp will have
		// printed its "ERROR: Sign in / region locked / format unavailable"
		// line by now because we only reach this branch after the pipeline
		// broke (which usually means yt-dlp already exited).
		hint := extractPipelineErrorHint(yt, ff, &ytErrBuf, &ffErrBuf)
		if hint != "" {
			return fmt.Errorf("%w (%s)", err, hint)
		}
		return err
	}
	return nil
}

// extractPipelineErrorHint — pick the most relevant stderr snippet from
// either yt-dlp or ffmpeg so the user toast says e.g. "ogg parse:… (yt-dlp:
// ERROR: Sign in to confirm you're not a bot)" instead of a generic
// "ogg parse: EOF". Truncated so the WS payload + toast stay readable.
//
// Snapshots whatever stderr both subprocesses have flushed so far; does
// not block waiting for them to exit (that happens in the cleanup
// defer). For the common YouTube-blocked-the-request case, yt-dlp
// writes its error and exits well before pumpOggToTrack returns, so
// the buffer already has the diagnostic by this point.
func extractPipelineErrorHint(_, _ *exec.Cmd, ytErr, ffErr *bytes.Buffer) string {
	yMsg := lastErrorLine(ytErr.String())
	fMsg := lastErrorLine(ffErr.String())

	switch {
	case yMsg != "" && fMsg != "":
		return fmt.Sprintf("yt-dlp: %s", yMsg) // yt-dlp upstream usually the real cause
	case yMsg != "":
		return fmt.Sprintf("yt-dlp: %s", yMsg)
	case fMsg != "":
		return fmt.Sprintf("ffmpeg: %s", fMsg)
	}
	return ""
}

// lastErrorLine — scan multi-line stderr for the most informative line
// (last line that mentions ERROR / WARNING / failed). Trims and caps at
// 160 chars so the toast doesn't wrap forever. Returns "" if nothing
// useful was logged.
func lastErrorLine(raw string) string {
	if raw == "" {
		return ""
	}
	var best string
	for _, line := range strings.Split(raw, "\n") {
		s := strings.TrimSpace(line)
		if s == "" {
			continue
		}
		// Prefer ERROR lines, then fall back to the last non-empty line.
		lower := strings.ToLower(s)
		if strings.Contains(lower, "error") || strings.Contains(lower, "failed") {
			best = s
		} else if best == "" {
			best = s
		}
	}
	if len(best) > 160 {
		best = best[:157] + "…"
	}
	return best
}

// pumpOggToTrack — read Ogg/Opus pages off ffmpeg's stdout, write each as a
// 20 ms Opus sample to the LiveKit track. Returns nil on clean EOF, error
// on parse / write failure.
//
// Assumes ffmpeg's Ogg muxer is configured (`-page_duration 20000`) so each
// Ogg page contains exactly one Opus packet. Pion's oggreader returns the
// page payload — for single-packet pages this is one Opus frame.
func pumpOggToTrack(reader io.Reader, track *lksdk.LocalSampleTrack) error {
	ogg, _, err := oggreader.NewWith(reader)
	if err != nil {
		log.Printf("[music] pumpOggToTrack: oggreader init failed err=%v", err)
		return fmt.Errorf("oggreader init: %w", err)
	}
	const frameDuration = 20 * time.Millisecond
	samplesWritten := 0
	for {
		page, _, perr := ogg.ParseNextPage()
		if errors.Is(perr, io.EOF) {
			log.Printf("[music] pumpOggToTrack: clean EOF after %d sample(s)", samplesWritten)
			return nil
		}
		if perr != nil {
			log.Printf("[music] pumpOggToTrack: ogg parse err after %d sample(s): %v", samplesWritten, perr)
			return fmt.Errorf("ogg parse: %w", perr)
		}
		if len(page) == 0 {
			continue
		}
		if werr := track.WriteSample(media.Sample{Data: page, Duration: frameDuration}, nil); werr != nil {
			log.Printf("[music] pumpOggToTrack: WriteSample failed after %d sample(s): %v", samplesWritten, werr)
			return fmt.Errorf("write sample: %w", werr)
		}
		samplesWritten++
		if samplesWritten == 1 {
			// One-shot log so we know the audio path actually started — silence
			// here = pipeline broken between ffmpeg stdout and the LK track.
			log.Printf("[music] pumpOggToTrack: first sample written successfully")
		}
	}
}

// scheduleIdleLeaveLocked — caller holds bot.mu. Arms a one-shot timer that
// calls Stop() if no track has been enqueued by then. Re-arming is handled
// by Enqueue cancelling the existing timer before appending.
func (s *musicBotService) scheduleIdleLeaveLocked(bot *botInstance) {
	bot.cancelIdleTimer()
	bot.idleTimer = time.AfterFunc(idleLeaveAfter, func() {
		log.Printf("[music] idle leave channel=%s", bot.channelID)
		_ = s.Stop(bot.channelID)
	})
}
