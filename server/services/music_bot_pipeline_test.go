package services

// Pipeline robustness tests: the stall watchdog that kills a wedged
// yt-dlp/ffmpeg pair, and the consecutive-failure cap that stops a bot instead
// of spinning the queue. Neither test shells out — the watchdog is driven
// through a hand-built Ogg stream over an io.Pipe, and the failure cap through
// the playTrackFn seam (same indirection idea as BackupService.runCmd).

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

// ─── Ogg fixtures ───
//
// pion's oggreader verifies the per-page CRC, so the test stream has to be
// byte-accurate. The checksum table below mirrors the one oggreader builds.

const (
	oggPageHeaderLen = 27
	oggBOS           = 0x02 // beginning-of-stream flag, required on the OpusHead page
)

func oggChecksumTable() [256]uint32 {
	var table [256]uint32
	const poly = 0x04c11db7
	for i := range table {
		r := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ poly
			} else {
				r <<= 1
			}
			table[i] = r
		}
	}
	return table
}

// oggPage assembles one Ogg page (header + lacing table + payload) with a
// valid CRC. Payloads stay under 255 bytes so a single lacing value suffices.
func oggPage(headerType byte, granule uint64, index uint32, payload []byte) []byte {
	if len(payload) >= 255 {
		panic("oggPage fixture only supports payloads < 255 bytes")
	}
	page := make([]byte, oggPageHeaderLen, oggPageHeaderLen+1+len(payload))
	copy(page[0:4], "OggS")
	page[4] = 0 // version
	page[5] = headerType
	binary.LittleEndian.PutUint64(page[6:14], granule)
	binary.LittleEndian.PutUint32(page[14:18], 0xdeadbeef) // serial
	binary.LittleEndian.PutUint32(page[18:22], index)
	// page[22:26] is the checksum, left zero while computing it.
	page[26] = 1 // one lacing segment
	page = append(page, byte(len(payload)))
	page = append(page, payload...)

	table := oggChecksumTable()
	var crc uint32
	for _, b := range page {
		crc = (crc << 8) ^ table[byte(crc>>24)^b]
	}
	binary.LittleEndian.PutUint32(page[22:26], crc)
	return page
}

// oggOpusHeadPage is the 19-byte OpusHead ID page (channel mapping family 0)
// that oggreader.NewWith consumes before any audio page is visible.
func oggOpusHeadPage() []byte {
	payload := make([]byte, 0, 19)
	payload = append(payload, "OpusHead"...)
	payload = append(payload, 1, 2) // version, channels
	payload = binary.LittleEndian.AppendUint16(payload, 312)
	payload = binary.LittleEndian.AppendUint32(payload, 48000)
	payload = binary.LittleEndian.AppendUint16(payload, 0) // output gain
	payload = append(payload, 0)                           // channel mapping family
	return oggPage(oggBOS, 0, 0, payload)
}

func oggAudioPage(index uint32, payload []byte) []byte {
	return oggPage(0, uint64(index)*960, index, payload)
}

// recordingTrack captures the samples the pump writes. It satisfies
// sampleWriter, the narrow subset of *lksdk.LocalSampleTrack the pump needs.
type recordingTrack struct {
	mu      sync.Mutex
	samples int
}

func (r *recordingTrack) WriteSample(media.Sample, *lksdk.SampleWriteOptions) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.samples++
	return nil
}

func (r *recordingTrack) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.samples
}

var _ sampleWriter = (*recordingTrack)(nil)

// ─── stall watchdog ───

// A hung yt-dlp writes one page and then neither writes nor exits. Before the
// watchdog, pumpOggToTrack blocked on that read forever: playTrack's deferred
// yt.Wait()/ff.Wait() never ran, so both subprocesses and the goroutine leaked
// until someone called Skip/Stop. The watchdog cancels the per-track context,
// CommandContext kills the pair, the read returns, and the defers reap.
func TestStallWatchdog_CancelsStalledPump(t *testing.T) {
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Stand-in for CommandContext's kill: cancelling the track context tears
	// the subprocess down, which closes ffmpeg's stdout and unblocks the read.
	go func() {
		<-ctx.Done()
		_ = pw.CloseWithError(errors.New("subprocess killed"))
	}()

	watchdog := newStallWatchdog(ctx, cancel, 80*time.Millisecond, 5*time.Millisecond, "chan-stall")
	defer watchdog.close()

	track := &recordingTrack{}
	pumped := make(chan error, 1)
	go func() { pumped <- pumpOggToTrack(pr, track, watchdog.progress) }()

	// One good page, then silence — no further data, no EOF.
	stream := append(oggOpusHeadPage(), oggAudioPage(1, []byte{0xfc, 0xff, 0xfe})...)
	if _, err := pw.Write(stream); err != nil {
		t.Fatalf("writing ogg fixture: %v", err)
	}

	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog never cancelled the stalled track context")
	}
	if !watchdog.stalled() {
		t.Fatal("watchdog.stalled() = false after firing; playTrack would report the stall as a clean finish")
	}

	select {
	case err := <-pumped:
		if err == nil {
			t.Log("pump returned nil (clean EOF on the killed pipe) — stall is reported via watchdog.stalled()")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pump did not return after the track context was cancelled")
	}

	if got := track.count(); got != 1 {
		t.Fatalf("wrote %d sample(s), want 1", got)
	}
}

// Progress keeps the watchdog quiet: a slow-but-alive stream must not be killed.
func TestStallWatchdog_ProgressKeepsTrackAlive(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watchdog := newStallWatchdog(ctx, cancel, 200*time.Millisecond, 5*time.Millisecond, "chan-alive")
	defer watchdog.close()

	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		watchdog.progress()
		time.Sleep(10 * time.Millisecond)
		if watchdog.stalled() {
			t.Fatal("watchdog fired while pages were still flowing")
		}
	}
	if ctx.Err() != nil {
		t.Fatalf("track context cancelled despite steady progress: %v", ctx.Err())
	}
}

// A pipeline that never emits a first page (yt-dlp hanging on resolution) is
// the more common wedge — progress is seeded at arm time so it is caught too.
func TestStallWatchdog_FiresWhenNoPageEverArrives(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	watchdog := newStallWatchdog(ctx, cancel, 50*time.Millisecond, 5*time.Millisecond, "chan-silent")
	defer watchdog.close()

	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog did not fire on a pipeline that produced no pages at all")
	}
}

// ─── consecutive-failure cap ───

// newFailureCapTestBot wires a service whose per-track work is stubbed, plus a
// hub that records every broadcast.
func newFailureCapTestBot(t *testing.T, play func(bot *botInstance, track *models.MusicTrack) error) (*musicBotService, *botInstance, func() []ws.Event) {
	t.Helper()

	var mu sync.Mutex
	var events []ws.Event
	hub := &testutil.MockBroadcaster{
		BroadcastToServerFn: func(_ string, e ws.Event) {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, e)
		},
	}

	svc := &musicBotService{
		bots:        map[string]*botInstance{},
		hub:         hub,
		playTrackFn: play,
	}
	bot := &botInstance{channelID: "chan-1", serverID: "srv-1", roomName: "srv-1:chan-1"}
	for i := 0; i < 10; i++ {
		bot.queue = append(bot.queue, models.MusicTrack{VideoID: fmt.Sprintf("vid-%d", i)})
	}
	svc.bots[bot.channelID] = bot

	return svc, bot, func() []ws.Event {
		mu.Lock()
		defer mu.Unlock()
		return append([]ws.Event(nil), events...)
	}
}

// playLoop used to continue to the next track on ANY error with no cap, so a
// broken yt-dlp binary burned through the whole queue in a tight loop. After
// N back-to-back failures the bot stops and says why.
func TestPlayLoop_StopsAfterConsecutiveFailures(t *testing.T) {
	var attempts atomic.Int32
	svc, bot, recorded := newFailureCapTestBot(t, func(*botInstance, *models.MusicTrack) error {
		attempts.Add(1)
		return errors.New("yt-dlp: executable file not found in $PATH")
	})

	done := make(chan struct{})
	go func() { defer close(done); svc.playLoop(bot) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("playLoop never returned — the failure cap is not stopping the bot")
	}

	if got := attempts.Load(); got != maxConsecutiveTrackFailures {
		t.Fatalf("playTrack called %d time(s), want exactly %d", got, maxConsecutiveTrackFailures)
	}
	if svc.lookupBot(bot.channelID) != nil {
		t.Fatal("bot still registered after the failure cap tripped; Stop() was not called")
	}

	var errEvents int
	for _, e := range recorded() {
		if e.Op != "music_bot_error" {
			continue
		}
		errEvents++
		data, ok := e.Data.(map[string]any)
		if !ok {
			t.Fatalf("music_bot_error payload = %T, want map[string]any", e.Data)
		}
		if data["channel_id"] != bot.channelID {
			t.Fatalf("music_bot_error channel_id = %v, want %s", data["channel_id"], bot.channelID)
		}
		if msg, _ := data["error"].(string); msg == "" {
			t.Fatal("music_bot_error carried no error text; users would see the bot vanish with no reason")
		}
	}
	if errEvents != 1 {
		t.Fatalf("broadcast %d music_bot_error event(s), want exactly 1", errEvents)
	}
}

// The cap counts CONSECUTIVE failures: one good track resets it, so an
// occasional dud video never stops a working bot.
func TestPlayLoop_SuccessResetsFailureCounter(t *testing.T) {
	var attempts atomic.Int32
	svc, bot, recorded := newFailureCapTestBot(t, func(*botInstance, *models.MusicTrack) error {
		// fail, fail, succeed, fail, fail, succeed, ... never 3 in a row
		if attempts.Add(1)%3 == 0 {
			return nil
		}
		return errors.New("transient extraction error")
	})

	done := make(chan struct{})
	go func() { defer close(done); svc.playLoop(bot) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("playLoop never returned")
	}

	// All 10 queued tracks should have been attempted, and the bot should have
	// gone idle (empty queue) rather than being stopped by the cap.
	if got := attempts.Load(); got != 10 {
		t.Fatalf("playTrack called %d time(s), want all 10 queued tracks attempted", got)
	}
	if svc.lookupBot(bot.channelID) == nil {
		t.Fatal("bot was stopped despite never failing 3 times in a row")
	}
	for _, e := range recorded() {
		if e.Op == "music_bot_error" {
			t.Fatal("broadcast a music_bot_error even though the failure cap was never reached")
		}
	}
	bot.mu.Lock()
	idleArmed := bot.idleTimer != nil
	bot.cancelIdleTimer()
	bot.mu.Unlock()
	if !idleArmed {
		t.Fatal("idle-leave timer was not armed after the queue drained")
	}
}

// ─── StopAll ───

// SIGTERM must tear the bots down through the normal Stop() path; otherwise the
// container runtime SIGKILLs yt-dlp/ffmpeg mid-write and the LiveKit rooms are
// left holding a ghost participant until the server times them out.
func TestStopAll_StopsEveryBot(t *testing.T) {
	svc := &musicBotService{
		bots: map[string]*botInstance{},
		hub:  &testutil.MockBroadcaster{},
	}
	for _, id := range []string{"chan-a", "chan-b", "chan-c"} {
		svc.bots[id] = &botInstance{channelID: id, serverID: "srv-1", roomName: "srv-1:" + id}
	}

	svc.StopAll()

	svc.mu.RLock()
	remaining := len(svc.bots)
	svc.mu.RUnlock()
	if remaining != 0 {
		t.Fatalf("%d bot(s) still registered after StopAll", remaining)
	}
}

// ─── playTrack's SSRF guard (security review, 2026-08-01) ───

// TestPlayTrackYtdlpArgs_RestrictsToYoutubeExtractors mirrors
// TestExtractTracksArgs_RestrictsToYoutubeExtractors (music_bot_metadata_test.go)
// for playTrack's yt-dlp invocation — see that test's comment for why the
// flag matters and why this test can only pin its presence in argv, not that
// GenericIE actually stays disabled.
func TestPlayTrackYtdlpArgs_RestrictsToYoutubeExtractors(t *testing.T) {
	args := playTrackYtdlpArgs("https://www.youtube.com/watch?v=x")
	assertHasAdjacentPair(t, args, "--use-extractors", "Youtube.*")
}

// stubHangingResolver blocks until its context is cancelled, then returns
// the context's error — a stand-in for a wedged DNS resolution that never
// completes on its own.
type stubHangingResolver struct{}

func (stubHangingResolver) LookupIPAddr(ctx context.Context, _ string) ([]net.IPAddr, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// TestPlayTrack_GuardHasOwnDeadline pins the guard's bounded timeout:
// playTrack's SSRF guard call must carry its own deadline, independent of
// the per-track pipeline context, which doesn't exist yet at guard time —
// the stall watchdog that would otherwise catch a wedge isn't armed until
// well after this call runs. Before the fix, this guard ran on a bare
// context.WithCancel(Background()) with no deadline, so a wedged resolver
// blocked the playLoop goroutine forever. The stub resolver here hangs until
// ITS OWN context is cancelled, so this test only finishes quickly if
// playTrack handed the guard a context with a deadline.
func TestPlayTrack_GuardHasOwnDeadline(t *testing.T) {
	origResolver := musicURLResolver
	musicURLResolver = stubHangingResolver{}
	t.Cleanup(func() { musicURLResolver = origResolver })

	svc := &musicBotService{}
	bot := &botInstance{channelID: "channel-1"}
	track := &models.MusicTrack{VideoID: "vid", Title: "t", URL: "https://www.youtube.com/watch?v=x"}

	done := make(chan error, 1)
	go func() { done <- svc.playTrack(bot, track) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a DNS-timeout rejection, got nil — the guard did not actually wait on the hanging resolver")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("playTrack did not return within 10s — the guard has no bounded deadline")
	}
}

// TestPlayTrack_GuardRejectionLeavesCancelFnUnset pins the guard/cancelFn
// ordering: a guard rejection must never leave bot.cancelFn pointing at a
// pipeline that was never started. Before the fix, bot.cancelFn was assigned
// before the guard ran; an early return on rejection skipped the defer that
// nils it back out afterwards, leaving a stale cancelFn on the bot. Uses a
// disallowed host so the guard rejects immediately with no DNS wait.
func TestPlayTrack_GuardRejectionLeavesCancelFnUnset(t *testing.T) {
	svc := &musicBotService{}
	bot := &botInstance{channelID: "channel-1"}
	track := &models.MusicTrack{VideoID: "vid", Title: "t", URL: "https://evil.example/watch?v=x"}

	err := svc.playTrack(bot, track)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got %v", err)
	}

	bot.mu.Lock()
	defer bot.mu.Unlock()
	if bot.cancelFn != nil {
		t.Fatal("guard rejection left bot.cancelFn set — a later Skip()/Stop() would invoke a cancel func for a pipeline that never started")
	}
}
