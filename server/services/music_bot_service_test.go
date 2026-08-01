package services

// Enqueue resource-limit tests (security scan 2026-07-31, finding N-15):
// extraction concurrency bound and queue-length cap. Neither test touches
// LiveKit or spawns a real yt-dlp subprocess -- getOrCreateBot's LiveKit
// dial path is bypassed entirely by seeding svc.bots directly, and
// extractTracksFn (the same seam idea as playTrackFn in
// music_bot_pipeline.go) stands in for the real yt-dlp call. Each seeded
// bot starts with a non-nil currentTrack so Enqueue's wasIdle branch never
// fires and playLoop is never spawned -- these tests only exercise Enqueue.

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
// never reached. currentTrack is pre-set (non-nil) so wasIdle is always
// false and Enqueue never spawns playLoop.
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
	}
	return svc
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
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := svc.Enqueue(context.Background(), "user-1", "ch-1", "https://youtube.com/watch?v=x")
			results[i] = err
		}(i)
	}

	// Wait for exactly maxConcurrentMusicExtractions to be blocked in-flight
	// before releasing them -- the semaphore is non-blocking, so every other
	// goroutine has already failed fast by this point.
	deadline := time.Now().Add(2 * time.Second)
	for inFlight.Load() < maxConcurrentMusicExtractions && time.Now().Before(deadline) {
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
