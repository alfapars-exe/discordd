package services

// Concurrency tests for the bot lifecycle: a panicking track (P2), Enqueue
// racing the LiveKit connect (P3), and Enqueue racing a Stop or the idle
// timer (P4). Each one used to wedge the bot or drop a request silently.
// LiveKit and the subprocess pipeline are replaced by the connectBotFn and
// playTrackFn seams; nothing here dials out or spawns a process.

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

const (
	concTestChannel = "ch"
	concTestServer  = "srv"
	concTestURL     = "https://www.youtube.com/watch?v=x"
)

// eventLog records every broadcast.
type eventLog struct {
	mu     sync.Mutex
	events []ws.Event
}

func (l *eventLog) hub() *testutil.MockBroadcaster {
	return &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, e ws.Event) {
		l.mu.Lock()
		l.events = append(l.events, e)
		l.mu.Unlock()
	}}
}

func (l *eventLog) snapshot() []ws.Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ws.Event(nil), l.events...)
}

// newConcurrencyTestService wires a service with stubbed extraction and the
// given per-track work. No bot is seeded. Every bot's idle timer is
// cancelled at cleanup so none outlives its test.
func newConcurrencyTestService(t *testing.T, log *eventLog, play func(*botInstance, *models.MusicTrack) error) *musicBotService {
	t.Helper()
	svc := &musicBotService{
		bots: map[string]*botInstance{},
		channels: &stubChannelGetter{channel: &models.Channel{
			ID: concTestChannel, ServerID: concTestServer, Type: models.ChannelTypeVoice,
		}},
		users:       stubMusicUserGetter{},
		hub:         log.hub(),
		extractSem:  make(chan struct{}, maxConcurrentMusicExtractions),
		playTrackFn: play,
		extractTracksFn: func(_ context.Context, u, _, _ string) ([]models.MusicTrack, error) {
			return []models.MusicTrack{{VideoID: "v", URL: u, Title: "t"}}, nil
		},
		connectBotFn: func(context.Context, *botInstance) error {
			return nil
		},
	}
	t.Cleanup(func() {
		svc.mu.RLock()
		bots := make([]*botInstance, 0, len(svc.bots))
		for _, b := range svc.bots {
			bots = append(bots, b)
		}
		svc.mu.RUnlock()
		for _, b := range bots {
			b.mu.Lock()
			b.cancelIdleTimer()
			b.mu.Unlock()
		}
	})
	return svc
}

// seedIdleBot registers an already-connected, idle bot (as after an earlier
// session drained its queue).
func seedIdleBot(svc *musicBotService) *botInstance {
	bot := &botInstance{channelID: concTestChannel, serverID: concTestServer, roomName: concTestServer + ":" + concTestChannel}
	svc.bots[concTestChannel] = bot
	return bot
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// botIdle reports whether the bot has no running loop and no current track.
func botIdle(bot *botInstance) bool {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	return !bot.loopRunning && bot.currentTrack == nil
}

// ─── P2: a panicking track ───

// A panic inside playTrack used to be recovered by logx.Go around the whole
// loop — leaving currentTrack set forever, so every later Enqueue saw a
// "busy" bot and never started a loop. Now the panic is one counted failure
// (reason unknown) and the bot keeps working.
func TestPlayLoop_PanicDoesNotWedgeBot(t *testing.T) {
	log := &eventLog{}
	var calls atomic.Int32
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		if calls.Add(1) == 1 {
			panic("simulated nil pointer dereference")
		}
		return nil
	})
	bot := seedIdleBot(svc)

	if _, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL); err != nil {
		t.Fatalf("Enqueue A: %v", err)
	}
	waitFor(t, "loop to finish track A", func() bool { return calls.Load() == 1 && botIdle(bot) })

	if _, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL); err != nil {
		t.Fatalf("Enqueue B: %v", err)
	}
	waitFor(t, "track B to be played", func() bool { return calls.Load() == 2 && botIdle(bot) })

	payloads := musicBotErrorPayloads(t, log.snapshot())
	if len(payloads) != 1 {
		t.Fatalf("broadcast %d music_bot_error event(s), want 1 (for the panicking track)", len(payloads))
	}
	if p := payloads[0]; p["reason"] != string(reasonUnknown) || p["fatal"] != false || p["failures"] != float64(1) {
		t.Fatalf("music_bot_error = %v, want reason unknown, non-fatal, failures 1", p)
	}
}

// The panic is recovered per track, not per loop: the rest of the queue
// plays in the same loop.
func TestPlayLoop_PanicMidQueueContinues(t *testing.T) {
	log := &eventLog{}
	var mu sync.Mutex
	var played []string
	svc := newConcurrencyTestService(t, log, func(_ *botInstance, tr *models.MusicTrack) error {
		mu.Lock()
		played = append(played, tr.VideoID)
		mu.Unlock()
		if tr.VideoID == "boom" {
			panic("simulated panic")
		}
		return nil
	})
	bot := seedIdleBot(svc)
	bot.queue = []models.MusicTrack{{VideoID: "boom"}, {VideoID: "ok"}}
	bot.loopRunning = true

	escaped := make(chan any, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { escaped <- recover() }()
		svc.playLoop(bot)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("playLoop never returned")
	}
	if r := <-escaped; r != nil {
		t.Fatalf("panic escaped playLoop: %v", r)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(played) != 2 || played[0] != "boom" || played[1] != "ok" {
		t.Fatalf("played %v in one loop, want [boom ok]", played)
	}
	if !botIdle(bot) {
		t.Fatal("bot not idle after the queue drained")
	}
}

// ─── P3: Enqueue racing the LiveKit connect ───

// getOrCreateBot used to publish the bot in s.bots before connecting it, so
// a second Enqueue during the dial got a half-built bot (no room, no audio
// track), played on it, and panicked. Now waiters block until the connect
// finishes, and a failed connect is an error for all of them.
func TestGetOrCreateBot_ConnectFailureNotHandedOut(t *testing.T) {
	log := &eventLog{}
	var playCalls, connects atomic.Int32
	release := make(chan struct{})
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		playCalls.Add(1)
		return nil
	})
	svc.connectBotFn = func(context.Context, *botInstance) error {
		connects.Add(1)
		<-release
		return errors.New("livekit unreachable (simulated)")
	}

	first := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "u1", concTestChannel, concTestURL)
		first <- err
	}()
	waitFor(t, "first Enqueue to start connecting", func() bool { return connects.Load() == 1 })
	connecting := svc.lookupBot(concTestChannel)
	if connecting == nil {
		t.Fatal("connecting bot not published in the map")
	}

	second := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "u2", concTestChannel, concTestURL)
		second <- err
	}()
	// The connect must not finish until the second Enqueue is parked on it;
	// one that arrived after the failure would rightly dial again and the
	// connect count below would depend on scheduling.
	waitFor(t, "second Enqueue to wait on the in-flight connect", func() bool {
		select {
		case err := <-second:
			t.Fatalf("second Enqueue returned (err=%v) while the connect was still in flight; it was handed a half-built bot", err)
		default:
		}
		return connecting.readyWaits.Load() == 1
	})

	close(release)
	if err := <-first; err == nil {
		t.Fatal("first Enqueue succeeded despite the failed connect")
	}
	if err := <-second; err == nil {
		t.Fatal("second Enqueue succeeded despite the failed connect")
	}
	time.Sleep(50 * time.Millisecond)
	if n := playCalls.Load(); n != 0 {
		t.Fatalf("playTrack ran %d time(s) on a bot that never connected", n)
	}
	if n := connects.Load(); n != 1 {
		t.Fatalf("connect ran %d times, want 1", n)
	}
	if svc.lookupBot(concTestChannel) != nil {
		t.Fatal("failed bot left in the map")
	}
}

// Concurrent Enqueues on a fresh channel share one connect, both succeed,
// and only one playLoop runs (two idle Enqueues used to both see
// currentTrack == nil and start two loops).
func TestGetOrCreateBot_WaitersShareOneConnect(t *testing.T) {
	log := &eventLog{}
	var connects, inFlight, maxInFlight, plays atomic.Int32
	release := make(chan struct{})
	gate := make(chan struct{})
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		n := inFlight.Add(1)
		for {
			m := maxInFlight.Load()
			if n <= m || maxInFlight.CompareAndSwap(m, n) {
				break
			}
		}
		<-gate
		inFlight.Add(-1)
		plays.Add(1)
		return nil
	})
	svc.connectBotFn = func(context.Context, *botInstance) error {
		connects.Add(1)
		<-release
		return nil
	}

	const n = 2
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() {
			_, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL)
			errs <- err
		}()
	}
	waitFor(t, "connect to start", func() bool { return connects.Load() == 1 })
	connecting := svc.lookupBot(concTestChannel)
	if connecting == nil {
		t.Fatal("connecting bot not published in the map")
	}
	waitFor(t, "the other Enqueue to wait on the connect", func() bool { return connecting.readyWaits.Load() == 1 })
	close(release)
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}
	time.Sleep(50 * time.Millisecond) // a second loop, if any, would be inside play now
	close(gate)

	bot := svc.lookupBot(concTestChannel)
	if bot == nil {
		t.Fatal("bot missing after a successful connect")
	}
	waitFor(t, "both tracks to play", func() bool { return plays.Load() == n && botIdle(bot) })
	if c := connects.Load(); c != 1 {
		t.Fatalf("connect ran %d times, want 1", c)
	}
	if m := maxInFlight.Load(); m != 1 {
		t.Fatalf("max concurrent playTrack = %d, want 1 (one playLoop per bot)", m)
	}
}

// playTrack on a bot without an audio track must fail cleanly instead of
// handing a nil *LocalSampleTrack to the pump (where WriteSample panics).
func TestPlayTrack_NilAudioTrackFailsCleanly(t *testing.T) {
	origResolver := musicURLResolver
	musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}
	t.Cleanup(func() { musicURLResolver = origResolver })

	svc := &musicBotService{}
	bot := &botInstance{channelID: "channel-1"}
	track := &models.MusicTrack{VideoID: "vid", Title: "t", URL: concTestURL}

	err := svc.playTrack(bot, track)
	if !errors.Is(err, errBotNotConnected) {
		t.Fatalf("playTrack = %v, want errBotNotConnected", err)
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	if bot.cancelFn != nil {
		t.Fatal("bot.cancelFn set for a pipeline that never started")
	}
}

// ─── P4: Enqueue racing Stop and the idle timer ───

// A Stop landing between getOrCreateBot and Enqueue taking bot.mu used to
// queue the track onto the dead bot: 200 OK, nothing played. Now Enqueue
// re-checks under bot.mu and moves to a fresh bot.
func TestEnqueue_AfterConcurrentStopRecreatesBot(t *testing.T) {
	log := &eventLog{}
	var plays atomic.Int32
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		plays.Add(1)
		return nil
	})
	old := seedIdleBot(svc)

	old.mu.Lock()
	res := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL)
		res <- err
	}()
	time.Sleep(150 * time.Millisecond) // Enqueue is now parked on old.mu

	// What stopBot does to the old bot, while Enqueue waits for its lock.
	old.stopping.Store(true)
	svc.mu.Lock()
	delete(svc.bots, concTestChannel)
	svc.mu.Unlock()
	old.stopFlag = true
	old.mu.Unlock()

	if err := <-res; err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	waitFor(t, "the track to play", func() bool { return plays.Load() == 1 })

	cur := svc.lookupBot(concTestChannel)
	if cur == nil || cur == old {
		t.Fatalf("channel bot = %p, want a fresh bot (old = %p)", cur, old)
	}
	old.mu.Lock()
	defer old.mu.Unlock()
	if len(old.queue) != 0 {
		t.Fatalf("old bot holds %d orphaned track(s)", len(old.queue))
	}
}

// An explicit Stop (/music/stop, channel emptied) landing while /play is
// still dialing LiveKit used to be undone: connectBotToRoom returned
// errBotStopping, getOrCreateBot retried with a fresh bot, and the bot
// rejoined the channel the user had just stopped. Now that /play fails with a
// client-facing 400 and nothing is left in the channel.
func TestGetOrCreateBot_ExplicitStopDuringConnectIsNotUndone(t *testing.T) {
	log := &eventLog{}
	var connects, plays atomic.Int32
	release := make(chan struct{})
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		plays.Add(1)
		return nil
	})
	svc.connectBotFn = func(_ context.Context, bot *botInstance) error {
		if connects.Add(1) > 1 {
			return nil // a retry would connect fine; it must not happen
		}
		<-release
		// What connectBotToRoom does when stopBot ran during the dial.
		bot.mu.Lock()
		defer bot.mu.Unlock()
		if bot.stopFlag || bot.stopping.Load() {
			return errBotStopping
		}
		return nil
	}

	res := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL)
		res <- err
	}()
	waitFor(t, "Enqueue to start connecting", func() bool { return connects.Load() == 1 })

	if err := svc.Stop(concTestChannel); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	close(release)

	err := <-res
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("Enqueue = %v, want a pkg.ErrBadRequest (bot stopped)", err)
	}
	time.Sleep(50 * time.Millisecond)
	if n := connects.Load(); n != 1 {
		t.Fatalf("connect ran %d times, want 1 (no retry after an explicit stop)", n)
	}
	if n := plays.Load(); n != 0 {
		t.Fatalf("playTrack ran %d time(s) after an explicit stop", n)
	}
	if b := svc.lookupBot(concTestChannel); b != nil {
		t.Fatal("a bot is serving the channel after an explicit stop")
	}
}

// stopBot is keyed by bot identity: stopping an old bot must not remove the
// replacement already serving the channel, nor send the old bot's final
// IsActive=false state (clients key the panel by channel, so it would hide
// the replacement's panel).
func TestStopBot_DoesNotRemoveReplacement(t *testing.T) {
	log := &eventLog{}
	svc := &musicBotService{bots: map[string]*botInstance{}, hub: log.hub()}
	a := &botInstance{channelID: concTestChannel, serverID: concTestServer}
	a.stopping.Store(true)
	b := &botInstance{channelID: concTestChannel, serverID: concTestServer}
	svc.bots[concTestChannel] = b

	svc.stopBot(a)

	if got := svc.lookupBot(concTestChannel); got != b {
		t.Fatalf("channel bot = %p after stopBot(old), want the replacement %p", got, b)
	}
	if ev := log.snapshot(); len(ev) != 0 {
		t.Fatalf("stopBot(old) broadcast %d event(s) (%v) although a replacement serves the channel", len(ev), ev)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopFlag || b.stopping.Load() {
		t.Fatal("stopBot(old) stopped the replacement")
	}
}

// The control case: with no replacement, stopBot still sends exactly one
// final IsActive=false state for the channel.
func TestStopBot_SendsFinalStateWhenNotReplaced(t *testing.T) {
	log := &eventLog{}
	svc := &musicBotService{bots: map[string]*botInstance{}, hub: log.hub()}
	a := &botInstance{channelID: concTestChannel, serverID: concTestServer}
	svc.bots[concTestChannel] = a

	svc.stopBot(a)

	if svc.lookupBot(concTestChannel) != nil {
		t.Fatal("stopped bot left in the map")
	}
	if n := countFinalStates(log.snapshot()); n != 1 {
		t.Fatalf("stopBot sent %d final IsActive=false state(s), want 1", n)
	}
}

// countFinalStates counts stopBot's final music_bot_state pushes. stopBot
// sends its state as a models.MusicBotChannelState value; broadcastState
// sends snapshots as *models.MusicBotChannelState, so the two are told apart
// by type (test bots have no LiveKit room, so IsActive alone would not do).
func countFinalStates(events []ws.Event) int {
	n := 0
	for _, e := range events {
		if e.Op != "music_bot_state" {
			continue
		}
		data, _ := e.Data.(map[string]any)
		if st, ok := data["state"].(models.MusicBotChannelState); ok && !st.IsActive {
			n++
		}
	}
	return n
}

// The failure cap and an Enqueue landing in the window between playLoop
// giving up and stopBot clearing the bot. The Enqueue used to queue onto the
// doomed bot — 200 OK, then stopBot wiped its track — and stopBot's final
// IsActive=false then hid the panel of whatever bot served the channel next.
// Now stopping is set before the fatal event, so the Enqueue gets a fresh
// bot, and the doomed bot's final state is not sent over it. The Enqueue runs
// synchronously from the hub callback for the fatal music_bot_error, which
// is exactly inside that window — no timing involved.
func TestPlayLoop_FailureCapEnqueueGetsFreshBot(t *testing.T) {
	log := &eventLog{}
	var plays atomic.Int32
	var doomed *botInstance
	svc := newConcurrencyTestService(t, log, func(b *botInstance, _ *models.MusicTrack) error {
		if b == doomed {
			return errors.New("yt-dlp exited 1 (simulated)")
		}
		plays.Add(1)
		return nil
	})
	record := log.hub().BroadcastToServerFn
	enqueued := make(chan error, 1)
	svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(serverID string, e ws.Event) {
		record(serverID, e)
		p, ok := e.Data.(models.MusicBotErrorPayload)
		if !ok || !p.Fatal {
			return
		}
		if !doomed.stopping.Load() {
			t.Error("fatal music_bot_error broadcast before the bot was marked stopping")
		}
		_, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL)
		enqueued <- err
	}}
	doomed = seedIdleBot(svc)
	doomed.queue = []models.MusicTrack{{VideoID: "a"}, {VideoID: "b"}, {VideoID: "c"}}
	doomed.loopRunning = true

	done := make(chan struct{})
	go func() { defer close(done); svc.playLoop(doomed) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("playLoop never returned — the failure cap is not stopping the bot")
	}

	select {
	case err := <-enqueued:
		if err != nil {
			t.Fatalf("Enqueue during the failure-cap window: %v", err)
		}
	default:
		t.Fatal("no fatal music_bot_error was broadcast")
	}
	fresh := svc.lookupBot(concTestChannel)
	if fresh == nil || fresh == doomed {
		t.Fatalf("channel bot = %p, want a fresh bot (doomed = %p)", fresh, doomed)
	}
	waitFor(t, "the enqueued track to play on the fresh bot", func() bool { return plays.Load() == 1 && botIdle(fresh) })
	if n := countFinalStates(log.snapshot()); n != 0 {
		t.Fatalf("stopBot(doomed) sent %d final IsActive=false state(s) over the fresh bot", n)
	}
}

// ─── Skip/Stop before the pipeline is running ───

// gatedResolver holds the URL guard's DNS lookup until release is closed,
// parking playTrack before bot.cmd and bot.cancelFn exist.
type gatedResolver struct {
	entered chan struct{} // buffered 1
	release chan struct{}
}

func (r gatedResolver) LookupIPAddr(ctx context.Context, _ string) ([]net.IPAddr, error) {
	select {
	case r.entered <- struct{}{}:
	default:
	}
	select {
	case <-r.release:
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Skip only kills bot.cmd, and stopBot only cancels bot.cancelFn. Both are
// unset while playTrack runs the URL guard (up to 5 s of DNS), and bot.cmd
// stays unset until both subprocesses have started. A Skip in that window
// used to kill nothing, so the skipped track played to its end; a Stop
// cancelled the context the subprocesses were about to start on, and the
// failed Start was broadcast as tool_missing. Each case parks playTrack in
// one window (the guard's DNS lookup, or the ytDlpPath call between
// cancelFn and the subprocess starts), issues the Skip/Stop, and lets it
// continue: the track must end without a music_bot_error and without
// anything going back on the queue.
func TestPlayTrack_SkipOrStopBeforePipelineRuns(t *testing.T) {
	for _, window := range []string{"url guard", "subprocess start"} {
		for _, action := range []string{"skip", "stop"} {
			t.Run(window+"/"+action, func(t *testing.T) {
				log := &eventLog{}
				svc := newConcurrencyTestService(t, log, nil) // nil: the real playTrack
				bot := seedIdleBot(svc)
				bot.queue = []models.MusicTrack{{VideoID: "v", Title: "t", URL: concTestURL}}
				bot.loopRunning = true
				audio, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{
					MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
				})
				if err != nil {
					t.Fatalf("NewLocalSampleTrack: %v", err)
				}
				bot.audioTrack = audio

				entered := make(chan struct{}, 1)
				release := make(chan struct{})
				open := sync.OnceFunc(func() { close(release) })
				t.Cleanup(open) // never leave playTrack parked if the test fails early

				origResolver, origYtDlpPath := musicURLResolver, ytDlpPath
				t.Cleanup(func() { musicURLResolver, ytDlpPath = origResolver, origYtDlpPath })
				if window == "url guard" {
					musicURLResolver = gatedResolver{entered: entered, release: release}
					ytDlpPath = func() (string, error) {
						t.Error("pipeline setup continued past the guard after a " + action)
						return "", errors.New("unreachable")
					}
				} else {
					musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}
					ytDlpPath = func() (string, error) {
						select {
						case entered <- struct{}{}:
						default:
						}
						<-release
						// Any harmless binary: if ffmpeg exists, the pair
						// starts and must be killed at once; if not, the
						// failed Start must not count as tool_missing.
						return exec.LookPath("true")
					}
				}

				done := make(chan struct{})
				go func() { defer close(done); svc.playLoop(bot) }()
				select {
				case <-entered:
				case <-time.After(5 * time.Second):
					t.Fatal("playTrack never reached the " + window)
				}

				switch action {
				case "skip":
					if err := svc.Skip(concTestChannel); err != nil {
						t.Fatalf("Skip: %v", err)
					}
				case "stop":
					if err := svc.Stop(concTestChannel); err != nil {
						t.Fatalf("Stop: %v", err)
					}
				}
				open()

				select {
				case <-done:
				case <-time.After(10 * time.Second):
					t.Fatal("the track did not end after the " + action)
				}

				if p := musicBotErrorPayloads(t, log.snapshot()); len(p) != 0 {
					t.Fatalf("a %s in the %s window broadcast music_bot_error %v; an intentional kill is not a failure", action, window, p)
				}
				bot.mu.Lock()
				queued, current, cmd, cancelFn := len(bot.queue), bot.currentTrack, bot.cmd, bot.cancelFn
				bot.mu.Unlock()
				if queued != 0 || current != nil {
					t.Fatalf("after the %s: %d queued track(s), current track %v; want none", action, queued, current)
				}
				if cmd != nil || cancelFn != nil {
					t.Fatal("bot.cmd / bot.cancelFn left set after the track ended")
				}
				switch action {
				case "skip":
					if svc.lookupBot(concTestChannel) != bot || bot.stopping.Load() {
						t.Fatal("Skip stopped the bot; it must only end the track")
					}
				case "stop":
					if svc.lookupBot(concTestChannel) != nil {
						t.Fatal("stopped bot left in the map")
					}
				}
			})
		}
	}
}

// ─── a panicking LiveKit connect ───

// A panic inside the connect used to skip both close(ready) and the map
// cleanup: the panic reached the HTTP recover middleware, but the bot stayed
// in the map un-stopped, so every later Enqueue on the channel found it and
// blocked in waitReady until its own context ended. Now the bot is abandoned
// like a failed connect (waiters get an error, the entry is removed) and the
// panic still propagates.
func TestGetOrCreateBot_ConnectPanicReleasesWaiters(t *testing.T) {
	log := &eventLog{}
	var plays, connects atomic.Int32
	release := make(chan struct{})
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
		plays.Add(1)
		return nil
	})
	svc.connectBotFn = func(context.Context, *botInstance) error {
		if connects.Add(1) == 1 {
			<-release
			panic("simulated connect panic")
		}
		return nil
	}

	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		_, _ = svc.Enqueue(context.Background(), "u1", concTestChannel, concTestURL)
	}()
	waitFor(t, "first Enqueue to start connecting", func() bool { return connects.Load() == 1 })
	connecting := svc.lookupBot(concTestChannel)
	if connecting == nil {
		t.Fatal("connecting bot not published in the map")
	}

	// context.Background(): before the fix this waiter blocked forever.
	waiter := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "u2", concTestChannel, concTestURL)
		waiter <- err
	}()
	waitFor(t, "second Enqueue to wait on the in-flight connect", func() bool { return connecting.readyWaits.Load() == 1 })

	close(release)
	select {
	case r := <-panicked:
		if r == nil {
			t.Fatal("connect panic was swallowed; it must still reach the recover middleware")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first Enqueue never returned")
	}
	select {
	case err := <-waiter:
		if err == nil {
			t.Fatal("waiter succeeded on a bot whose connect panicked")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter still blocked in waitReady after the connect panicked")
	}
	if !connecting.stopping.Load() {
		t.Fatal("bot whose connect panicked is not marked stopping")
	}
	if svc.lookupBot(concTestChannel) == connecting {
		t.Fatal("bot whose connect panicked left in the map")
	}

	// The channel is usable again: a fresh bot connects and plays.
	if _, err := svc.Enqueue(context.Background(), "u3", concTestChannel, concTestURL); err != nil {
		t.Fatalf("Enqueue after the panicked connect: %v", err)
	}
	fresh := svc.lookupBot(concTestChannel)
	if fresh == nil || fresh == connecting {
		t.Fatalf("channel bot = %p, want a fresh bot (panicked = %p)", fresh, connecting)
	}
	waitFor(t, "the track to play on the fresh bot", func() bool { return plays.Load() == 1 && botIdle(fresh) })
	if n := connects.Load(); n != 2 {
		t.Fatalf("connect ran %d times, want 2", n)
	}
}

// The idle timer must not stop a bot that got work in the meantime.
func TestIdleTimer_SkipsWhenWorkArrived(t *testing.T) {
	t.Run("enqueue before the timer fires", func(t *testing.T) {
		log := &eventLog{}
		gate := make(chan struct{})
		svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error {
			<-gate
			return nil
		})
		svc.idleLeaveOverride = 200 * time.Millisecond
		bot := seedIdleBot(svc)
		defer close(gate)

		bot.mu.Lock()
		svc.scheduleIdleLeaveLocked(bot)
		bot.mu.Unlock()
		if _, err := svc.Enqueue(context.Background(), "u", concTestChannel, concTestURL); err != nil {
			t.Fatalf("Enqueue: %v", err)
		}
		if svc.lookupBot(concTestChannel) != bot {
			// The timer beat Enqueue (a very slow run): the bot was
			// legitimately idle when it fired, so there is nothing to test.
			t.Skip("idle timer fired before Enqueue reached the bot")
		}
		time.Sleep(400 * time.Millisecond)
		if svc.lookupBot(concTestChannel) != bot || bot.stopping.Load() {
			t.Fatal("idle timer stopped a bot that was playing")
		}
	})

	// time.Timer.Stop cannot recall a callback that has already started.
	// Hold bot.mu across the fire so the callback is parked on it, make the
	// changes Enqueue makes, then let it run: it must back off.
	t.Run("callback already started when work arrives", func(t *testing.T) {
		log := &eventLog{}
		svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error { return nil })
		svc.idleLeaveOverride = 20 * time.Millisecond
		bot := seedIdleBot(svc)

		bot.mu.Lock()
		svc.scheduleIdleLeaveLocked(bot)
		time.Sleep(80 * time.Millisecond) // timer fired; callback waits for bot.mu
		bot.cancelIdleTimer()
		bot.queue = append(bot.queue, models.MusicTrack{VideoID: "late"})
		bot.mu.Unlock()

		time.Sleep(100 * time.Millisecond)
		if svc.lookupBot(concTestChannel) != bot || bot.stopping.Load() {
			t.Fatal("an already-fired idle callback stopped a bot that had just been given work")
		}
	})
}

func TestEnqueueSaveFailureRearmsIdleLeave(t *testing.T) {
	log := &eventLog{}
	svc := newConcurrencyTestService(t, log, func(*botInstance, *models.MusicTrack) error { return nil })
	svc.sessions = &memoryMusicSessions{items: make(map[string]models.MusicSession), failNext: 1}
	svc.idleLeaveOverride = time.Second
	bot := seedIdleBot(svc)
	bot.mu.Lock()
	svc.scheduleIdleLeaveLocked(bot)
	armed := bot.idleTimer != nil
	bot.mu.Unlock()
	if !armed {
		t.Fatal("test bot did not start with an idle timer")
	}

	if _, err := svc.Enqueue(context.Background(), "user", concTestChannel, concTestURL); err == nil {
		t.Fatal("enqueue succeeded despite injected persistence failure")
	}
	bot.mu.Lock()
	rearmed := bot.idleTimer != nil
	queueEmpty := len(bot.queue) == 0 && !bot.loopRunning
	bot.mu.Unlock()
	if !rearmed || !queueEmpty {
		t.Fatalf("failed enqueue left idle state inconsistent: timer=%v empty=%v", rearmed, queueEmpty)
	}
}
