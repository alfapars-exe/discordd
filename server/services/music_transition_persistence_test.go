package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/google/uuid"
	"sync"
	"testing"
	"time"
)

type transitionFaultStore struct {
	repository.MusicSessionRepository
	musicControlStore
	mu       sync.Mutex
	calls    int
	failures map[int]bool
	entered  chan struct{}
	release  chan struct{}
}

func (s *transitionFaultStore) SaveMusicTransition(ctx context.Context, h models.MusicControlHead, session *models.MusicSession) error {
	s.mu.Lock()
	s.calls++
	call := s.calls
	fail := s.failures[call]
	s.mu.Unlock()
	if call == 1 && s.entered != nil {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if fail {
		return errors.New("injected music transition write failure")
	}
	return s.musicControlStore.SaveMusicTransition(ctx, h, session)
}
func transitionFixture(t *testing.T, failures map[int]bool) (*musicBotService, *botInstance, *transitionFaultStore, models.MusicControlHead) {
	t.Helper()
	svc, control := guardedMusicFixture(t)
	head, err := svc.AdoptControl(context.Background(), "ch")
	if err != nil {
		t.Fatal(err)
	}
	store := &transitionFaultStore{MusicSessionRepository: svc.sessions, musicControlStore: control, failures: failures}
	svc.sessions = store
	bot := svc.bots["ch"]
	t.Cleanup(func() { bot.mu.Lock(); bot.cancelIdleTimer(); bot.mu.Unlock() })
	return svc, bot, store, head
}
func transitionCommand(head models.MusicControlHead, action string, revision uint64) MusicCommand {
	return MusicCommand{Action: action, SessionID: head.SessionID, RequestID: uuid.NewString(), ExpectedRevision: &revision}
}

func TestMusicTransitionFailureRetainsRevisionAndQueueUntilRetry(t *testing.T) {
	for _, dequeue := range []bool{false, true} {
		t.Run(map[bool]string{false: "drain", true: "dequeue"}[dequeue], func(t *testing.T) {
			svc, bot, store, head := transitionFixture(t, map[int]bool{1: true})
			oldID := bot.currentTrack.QueueItemID
			first, second := uuid.NewString(), uuid.NewString()
			if dequeue {
				bot.queue = []models.MusicTrack{{QueueItemID: first, VideoID: "first"}, {QueueItemID: second, VideoID: "second"}}
			}
			_, step := svc.nextTrack(bot)
			if step != loopRetry {
				t.Fatalf("failed transition step=%v", step)
			}
			state := svc.GetState("ch")
			durable, err := store.MusicControlHead(context.Background(), "ch")
			if err != nil {
				t.Fatal(err)
			}
			if state.Revision != head.Revision || durable.Revision != head.Revision || state.CurrentTrack.QueueItemID != oldID {
				t.Fatalf("uncommitted state exposed: %#v / %#v", state, durable)
			}
			if dequeue && (len(state.Queue) != 2 || state.Queue[0].QueueItemID != first || state.Queue[1].QueueItemID != second) {
				t.Fatal("failed dequeue lost or reordered items")
			}
			next, step := svc.nextTrack(bot)
			want := loopDrained
			if dequeue {
				want = loopPlay
			}
			if step != want {
				t.Fatalf("retry step=%v", step)
			}
			state = svc.GetState("ch")
			durable, err = store.MusicControlHead(context.Background(), "ch")
			if err != nil {
				t.Fatal(err)
			}
			if state.Revision != head.Revision+1 || durable.Revision != state.Revision {
				t.Fatal("retry did not converge exactly one revision")
			}
			sessions, err := store.List(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if dequeue {
				if next.QueueItemID != first || len(state.Queue) != 1 || state.Queue[0].QueueItemID != second || len(sessions) != 1 || len(sessions[0].Queue) != 2 || sessions[0].Queue[0].QueueItemID != first || sessions[0].Queue[1].QueueItemID != second {
					t.Fatalf("queue lost or duplicated: %#v %#v", state, sessions)
				}
			} else if state.CurrentTrack != nil || len(sessions) != 0 {
				t.Fatal("drain retained completed track")
			}
			if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", transitionCommand(head, "stop", state.Revision)); err != nil {
				t.Fatalf("fresh stop after retry: %v", err)
			}
		})
	}
}
func TestMusicTransitionFailedDrainStillAcceptsGuardedStop(t *testing.T) {
	svc, bot, _, head := transitionFixture(t, map[int]bool{1: true})
	bot.queue = nil
	if _, step := svc.nextTrack(bot); step != loopRetry {
		t.Fatal("expected retry")
	}
	cmd := transitionCommand(head, "stop", head.Revision)
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", cmd); err != nil {
		t.Fatalf("transient write broke stop: %v", err)
	}
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", cmd); err != nil {
		t.Fatalf("exact retry lost receipt: %v", err)
	}
	if _, step := svc.nextTrack(bot); step != loopStopped {
		t.Fatal("stopped bot revived by transition retry")
	}
}
func TestMusicTransitionCommitKeepsReadersOldAndRejectsConcurrentStaleCommand(t *testing.T) {
	svc, bot, store, head := transitionFixture(t, nil)
	store.entered = make(chan struct{})
	store.release = make(chan struct{})
	oldID := bot.currentTrack.QueueItemID
	bot.queue = []models.MusicTrack{{QueueItemID: uuid.NewString(), VideoID: "next"}}
	finished := make(chan loopStep, 1)
	go func() { _, step := svc.nextTrack(bot); finished <- step }()
	<-store.entered
	if state := svc.GetState("ch"); state.Revision != head.Revision || state.CurrentTrack.QueueItemID != oldID || len(state.Queue) != 1 {
		t.Fatal("reader saw pending transition")
	}
	cmdDone := make(chan error, 1)
	go func() {
		_, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", transitionCommand(head, "stop", head.Revision))
		cmdDone <- err
	}()
	close(store.release)
	if step := <-finished; step != loopPlay {
		t.Fatal("transition did not commit")
	}
	if err := <-cmdDone; !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("old concurrent control=%v", err)
	}
	if bot.stopping.Load() {
		t.Fatal("stale stop affected committed replacement track")
	}
	state := svc.GetState("ch")
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", transitionCommand(head, "stop", state.Revision)); err != nil {
		t.Fatalf("fresh control failed: %v", err)
	}
}
func TestMusicPlayLoopRetriesPersistenceWithoutReplayingAudio(t *testing.T) {
	svc, bot, store, head := transitionFixture(t, map[int]bool{2: true, 4: true})
	bot.currentTrack = nil
	first, second := uuid.NewString(), uuid.NewString()
	bot.queue = []models.MusicTrack{{QueueItemID: first, VideoID: "first"}, {QueueItemID: second, VideoID: "second"}}
	counts := map[string]int{}
	svc.playTrackFn = func(_ *botInstance, track *models.MusicTrack) error { counts[track.QueueItemID]++; return nil }
	done := make(chan struct{})
	go func() { svc.playLoop(bot); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("loop did not recover transient write failures")
	}
	if counts[first] != 1 || counts[second] != 1 || len(counts) != 2 {
		t.Fatalf("audio replayed or skipped: %#v", counts)
	}
	state := svc.GetState("ch")
	durable, err := store.MusicControlHead(context.Background(), "ch")
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != head.Revision+3 || durable.Revision != state.Revision || state.CurrentTrack != nil || len(state.Queue) != 0 {
		t.Fatalf("final state diverged: %#v %#v", state, durable)
	}
}

func TestMusicTransitionBackoffIsCappedAndStopInterruptsMaximumDelay(t *testing.T) {
	want := []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second}
	for i, delay := range want {
		if got := musicTransitionRetryDelay(i + 1); got != delay {
			t.Fatalf("attempt %d delay=%v, want %v", i+1, got, delay)
		}
	}
	if musicTransitionRetryDelay(1000) != 30*time.Second {
		t.Fatal("persistent failures exceeded the backoff cap")
	}
	svc, bot, _, head := transitionFixture(t, nil)
	done := make(chan struct{})
	go func() { waitMusicTransitionRetry(bot, musicTransitionRetryDelay(1000)); close(done) }()
	select {
	case <-done:
		t.Fatal("maximum delay did not wait before Stop")
	case <-time.After(75 * time.Millisecond):
	}
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", transitionCommand(head, "stop", head.Revision)); err != nil {
		t.Fatalf("Stop during maximum backoff: %v", err)
	}
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Stop waited for the 30-second backoff instead of interrupting it")
	}
}

func TestMusicPersistentTransitionFailureRetainsQueueAndAllowsStop(t *testing.T) {
	failures := map[int]bool{}
	for i := 1; i <= 100; i++ {
		failures[i] = true
	}
	svc, bot, store, head := transitionFixture(t, failures)
	t.Cleanup(func() { svc.stopBot(bot) })
	id := uuid.NewString()
	bot.currentTrack = nil
	bot.queue = []models.MusicTrack{{QueueItemID: id, VideoID: "pending"}}
	played := make(chan struct{}, 1)
	svc.playTrackFn = func(_ *botInstance, _ *models.MusicTrack) error { played <- struct{}{}; return nil }
	done := make(chan struct{})
	go func() { svc.playLoop(bot); close(done) }()
	deadline := time.After(4 * time.Second)
	for {
		store.mu.Lock()
		calls := store.calls
		store.mu.Unlock()
		if calls >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("persistent failure did not exercise increasing retry delays")
		case <-time.After(10 * time.Millisecond):
		}
	}
	select {
	case <-played:
		t.Fatal("audio started before a durable transition succeeded")
	default:
	}
	state := svc.GetState("ch")
	if state.Revision != head.Revision || state.CurrentTrack != nil || len(state.Queue) != 1 || state.Queue[0].QueueItemID != id {
		t.Fatalf("persistent failures changed the authoritative queue: %#v", state)
	}
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", transitionCommand(head, "stop", head.Revision)); err != nil {
		t.Fatalf("persistent transition failures blocked Stop: %v", err)
	}
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("play loop did not stop during retry backoff")
	}
}
