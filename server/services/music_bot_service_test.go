package services

// Enqueue resource-limit tests (security scan 2026-07-31, finding N-15):
// extraction concurrency bound and queue-length cap. Neither test touches
// LiveKit or spawns a real yt-dlp subprocess -- getOrCreateBot's LiveKit
// dial path is bypassed entirely by seeding svc.bots directly, and
// extractTracksFn (the same seam idea as playTrackFn in
// music_bot_pipeline.go) stands in for the real yt-dlp call. Each seeded
// bot starts with loopRunning set, so Enqueue believes a playLoop already
// owns the bot and never spawns one (which would run the real playTrack) --
// these tests only exercise Enqueue.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type stubChannelGetter struct {
	channel *models.Channel
	err     error
}

func (s *stubChannelGetter) GetByID(_ context.Context, _ string) (*models.Channel, error) {
	return s.channel, s.err
}

// stubMusicUserGetter always errors: Enqueue's display-name resolution is
// best-effort and falls back to the raw user ID on error, so this is enough
// to exercise Enqueue without a real user repository.
type stubMusicUserGetter struct{}

func (stubMusicUserGetter) GetByID(_ context.Context, _ string) (*models.User, error) {
	return nil, errors.New("stub: no user lookup")
}

// newTestMusicBotService builds a musicBotService with a bot already seeded
// for channelID/serverID, so Enqueue's getOrCreateBot fast path (existing
// entry in s.bots) is taken and the real LiveKit dial in connectBotToRoom is
// never reached. loopRunning is pre-set so Enqueue never spawns playLoop;
// currentTrack is set too, to look like a bot mid-track.
func newTestMusicBotService(channelID, serverID string) *musicBotService {
	svc := &musicBotService{
		bots: make(map[string]*botInstance),
		channels: &stubChannelGetter{channel: &models.Channel{
			ID: channelID, ServerID: serverID, Type: models.ChannelTypeVoice,
		}},
		users:      stubMusicUserGetter{},
		hub:        &testutil.MockBroadcaster{},
		extractSem: make(chan struct{}, maxConcurrentMusicExtractions),
	}
	svc.bots[channelID] = &botInstance{
		channelID:    channelID,
		serverID:     serverID,
		roomName:     serverID + ":" + channelID,
		currentTrack: &models.MusicTrack{VideoID: "already-playing"},
		loopRunning:  true,
	}
	return svc
}

func TestMusicQueueItemsHaveDistinctStableIDs(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "same-video"}, {VideoID: "same-video"}}, nil
	}
	tracks, err := svc.Enqueue(context.Background(), "user", "ch-1", "https://youtu.be/abcdefghijk")
	if err != nil {
		t.Fatal(err)
	}
	if tracks[0].QueueItemID == "" || tracks[1].QueueItemID == "" || tracks[0].QueueItemID == tracks[1].QueueItemID {
		t.Fatalf("queue IDs are not distinct: %#v", tracks)
	}
	state := svc.GetState("ch-1")
	if state.Revision != 1 || state.Queue[0].QueueItemID != tracks[0].QueueItemID {
		t.Fatalf("state=%#v", state)
	}
}

func TestMusicQueueRemoveAndReorderRequireCurrentRevision(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	bot := svc.bots["ch-1"]
	a, b, c := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"
	bot.queue = []models.MusicTrack{{QueueItemID: a}, {QueueItemID: b}, {QueueItemID: c}}
	bot.revision = 7
	if err := svc.RemoveQueueItem("ch-1", b, 6); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale remove=%v", err)
	}
	if err := svc.RemoveQueueItem("ch-1", b, 7); err != nil {
		t.Fatal(err)
	}
	if err := svc.ReorderQueue("ch-1", []string{c, a}, 8); err != nil {
		t.Fatal(err)
	}
	state := svc.GetState("ch-1")
	if state.Revision != 9 || state.Queue[0].QueueItemID != c || state.Queue[1].QueueItemID != a {
		t.Fatalf("state=%#v", state)
	}
	if err := svc.ReorderQueue("ch-1", []string{a, a}, 9); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("duplicate reorder=%v", err)
	}
}

func TestMusicQueueShuffleAndRepeatModes(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	bot := svc.bots["ch-1"]
	a, b, c := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"
	bot.queue = []models.MusicTrack{{QueueItemID: a}, {QueueItemID: b}, {QueueItemID: c}}
	bot.revision = 3
	if err := svc.ShuffleQueue("ch-1", 2); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale shuffle=%v", err)
	}
	if err := svc.ShuffleQueue("ch-1", 3); err != nil {
		t.Fatal(err)
	}
	state := svc.GetState("ch-1")
	seen := map[string]bool{}
	for _, track := range state.Queue {
		seen[track.QueueItemID] = true
	}
	if state.Revision != 4 || len(seen) != 3 || !seen[a] || !seen[b] || !seen[c] {
		t.Fatalf("shuffle lost queue entries: %#v", state)
	}
	if err := svc.SetRepeatMode("ch-1", "forever"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("invalid repeat=%v", err)
	}
	if err := svc.SetRepeatMode("ch-1", "all"); err != nil {
		t.Fatal(err)
	}
	if got := svc.GetState("ch-1"); got.RepeatMode != "all" || got.Revision != 5 {
		t.Fatalf("repeat state=%#v", got)
	}
}

func TestRepeatCompletedTrackSkipsSkippedAndFailedTracks(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	bot := svc.bots["ch-1"]
	bot.repeatMode = "all"
	track := models.MusicTrack{QueueItemID: "00000000-0000-4000-8000-000000000001"}
	svc.repeatCompletedTrack(bot, track)
	if len(bot.queue) != 1 || bot.queue[0].QueueItemID != track.QueueItemID {
		t.Fatalf("successful track was not repeated: %#v", bot.queue)
	}
	bot.queue = nil
	bot.skipFlag = true
	svc.repeatCompletedTrack(bot, track)
	if len(bot.queue) != 0 {
		t.Fatalf("skipped track was repeated: %#v", bot.queue)
	}
	// playLoop only invokes repeatCompletedTrack on nil playback errors, so
	// failed tracks cannot reach this helper at all.
}

func TestEnqueue_FullQueueReturnsError(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	bot := svc.bots["ch-1"]
	bot.queue = make([]models.MusicTrack, maxQueueLen)
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "new"}}, nil
	}
	tracks, err := svc.Enqueue(context.Background(), "user", "ch-1", "https://www.youtube.com/watch?v=YE7VzlLtp-4")
	if !errors.Is(err, pkg.ErrBadRequest) || len(tracks) != 0 || len(bot.queue) != maxQueueLen {
		t.Fatalf("full queue must reject, got %v / %v / %d", tracks, err, len(bot.queue))
	}
}

// TestEnqueue_ExtractionConcurrencyBounded -- N parallel Enqueue calls against
// a blocking extractTracksFn: at most maxConcurrentMusicExtractions may run
// concurrently, the rest must fail fast with a pkg.ErrBadRequest "busy"
// error (not skip silently -- unlike handlers/diagnostics.go's emailSem, the
// caller here is a synchronous HTTP request waiting on a response).
//
// Same shape as handlers/diagnostics_test.go's
// TestDiagnostics_EmailConcurrencyBounded (atomic.Int32 inFlight/maxSeen).
func TestEnqueue_ExtractionConcurrencyBounded(t *testing.T) {
	var inFlight, maxSeen atomic.Int32
	release := make(chan struct{})

	svc := newTestMusicBotService("ch-1", "srv-1")
	svc.extractTracksFn = func(_ context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error) {
		cur := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			old := maxSeen.Load()
			if cur <= old || maxSeen.CompareAndSwap(old, cur) {
				break
			}
		}
		<-release
		return []models.MusicTrack{{VideoID: "v", Title: "t", URL: urlStr, RequestedByUserID: requesterID, RequestedByName: requesterName}}, nil
	}

	const n = 10
	results := make([]error, n)
	var returned atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := svc.Enqueue(context.Background(), "user-1", "ch-1", "https://youtube.com/watch?v=x")
			results[i] = err
			returned.Add(1)
		}(i)
	}

	// Release only once every goroutine has either taken a slot (and is
	// blocked in extract) or already returned. Seeing the slots full is not
	// enough: a goroutine that has not reached the semaphore yet would find
	// a free slot after the release and succeed, making the counts below
	// depend on scheduling (it flaked that way under -race -count=20 on a
	// busy host). The in-flight ones cannot return before release, so
	// returned == n-max means all the others were turned away.
	deadline := time.Now().Add(5 * time.Second)
	for inFlight.Load() < maxConcurrentMusicExtractions || returned.Load() < n-maxConcurrentMusicExtractions {
		if time.Now().After(deadline) {
			t.Fatalf("before release: %d extraction(s) in flight (want %d), %d Enqueue(s) returned (want %d)",
				inFlight.Load(), maxConcurrentMusicExtractions, returned.Load(), n-maxConcurrentMusicExtractions)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := inFlight.Load(); got != maxConcurrentMusicExtractions {
		t.Fatalf("in-flight extractions = %d, want exactly %d before release", got, maxConcurrentMusicExtractions)
	}
	close(release)
	wg.Wait()

	if got := maxSeen.Load(); got > maxConcurrentMusicExtractions {
		t.Errorf("max concurrent extractions = %d, want <= %d", got, maxConcurrentMusicExtractions)
	}

	var busy, ok int
	for _, err := range results {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, pkg.ErrBadRequest):
			busy++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if ok != maxConcurrentMusicExtractions {
		t.Errorf("successful enqueues = %d, want %d", ok, maxConcurrentMusicExtractions)
	}
	if busy != n-maxConcurrentMusicExtractions {
		t.Errorf("busy rejections = %d, want %d", busy, n-maxConcurrentMusicExtractions)
	}
}

// TestEnqueue_QueueCapTruncates proves the maxQueueLen guard: a playlist
// extraction that would push the queue past the cap is truncated to fit,
// bot.queue never exceeds maxQueueLen, and the returned slice reflects only
// what was actually accepted -- the caller's signal that truncation happened.
func TestEnqueue_QueueCapTruncates(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	bot := svc.bots["ch-1"]
	// Two slots of room left under the cap.
	bot.queue = make([]models.MusicTrack, maxQueueLen-2)

	const extractedCount = 5
	extracted := make([]models.MusicTrack, extractedCount)
	for i := range extracted {
		extracted[i] = models.MusicTrack{VideoID: fmt.Sprintf("v%d", i)}
	}
	svc.extractTracksFn = func(_ context.Context, _, _, _ string) ([]models.MusicTrack, error) {
		return extracted, nil
	}

	accepted, err := svc.Enqueue(context.Background(), "user-1", "ch-1", "https://youtube.com/playlist?list=x")
	if err != nil {
		t.Fatalf("Enqueue returned error: %v", err)
	}
	if len(accepted) != 2 {
		t.Fatalf("accepted = %d tracks, want 2 (room left under the cap)", len(accepted))
	}
	if len(bot.queue) != maxQueueLen {
		t.Fatalf("queue length = %d, want exactly %d (the cap)", len(bot.queue), maxQueueLen)
	}
}

// TestEnqueue_AcceptsSingleTrack is the POSITIVE control: a normal
// single-track add still works end to end -- proves the semaphore and
// queue-cap changes above don't reject legitimate traffic.
func TestEnqueue_AcceptsSingleTrack(t *testing.T) {
	svc := newTestMusicBotService("ch-1", "srv-1")
	svc.extractTracksFn = func(_ context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "v1", Title: "Track", URL: urlStr, RequestedByUserID: requesterID, RequestedByName: requesterName}}, nil
	}

	accepted, err := svc.Enqueue(context.Background(), "user-1", "ch-1", "https://youtube.com/watch?v=v1")
	if err != nil {
		t.Fatalf("Enqueue returned error: %v", err)
	}
	if len(accepted) != 1 {
		t.Fatalf("accepted = %d tracks, want 1", len(accepted))
	}
	bot := svc.bots["ch-1"]
	if len(bot.queue) != 1 {
		t.Fatalf("queue length = %d, want 1", len(bot.queue))
	}
}
