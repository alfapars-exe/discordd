package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/google/uuid"
)

func guardedMusicFixture(t *testing.T) (*musicBotService, musicControlStore) {
	t.Helper()
	db := newBotTestDB(t)
	for _, q := range []string{
		`INSERT INTO users(id,username,password_hash) VALUES('actor','musicactor','hash')`,
		`INSERT INTO servers(id,name,owner_id) VALUES('srv','Music','actor')`,
		`INSERT INTO channels(id,name,type,server_id) VALUES('ch','Music','voice','srv')`,
	} {
		if _, err := db.Conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	svc := newTestMusicBotService("ch", "srv")
	svc.restored = map[string]models.MusicSession{}
	svc.sessions = repository.NewSQLiteMusicSessionRepo(db.Conn)
	svc.bots["ch"].currentTrack = &models.MusicTrack{QueueItemID: uuid.NewString(), DurationSeconds: 100, VideoID: "current"}
	return svc, svc.sessions.(musicControlStore)
}

func guardedCommand(t *testing.T, svc *musicBotService, action string) MusicCommand {
	t.Helper()
	head, err := svc.AdoptControl(context.Background(), "ch")
	if err != nil {
		t.Fatal(err)
	}
	var item string
	if state := svc.GetState("ch"); state != nil && state.CurrentTrack != nil {
		item = state.CurrentTrack.QueueItemID
	}
	return MusicCommand{Action: action, SessionID: head.SessionID, RequestID: uuid.NewString(), ExpectedRevision: &head.Revision, ExpectedQueueItemID: &item}
}

func TestMusicControlEnqueueConcurrentReplayAndIntentionalDuplicate(t *testing.T) {
	svc, _ := guardedMusicFixture(t)
	var extracts atomic.Int32
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		extracts.Add(1)
		return []models.MusicTrack{{URL: "https://youtu.be/0KbRhUtFwkc", VideoID: "same-video"}}, nil
	}
	command := guardedCommand(t, svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	var budgetCalls atomic.Int32
	command.BeforeNewWork = func() error {
		if budgetCalls.Add(1) > 1 {
			return errors.New("budget already exhausted")
		}
		return nil
	}
	var wg sync.WaitGroup
	responses := make(chan string, 2)
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", command)
			responses <- string(result)
			errs <- err
		}()
	}
	wg.Wait()
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if first, second := <-responses, <-responses; first != second {
		t.Fatalf("retry result differed: %s %s", first, second)
	}
	if extracts.Load() != 1 || len(svc.GetState("ch").Queue) != 1 {
		t.Fatalf("replayed extraction/queue: %d %#v", extracts.Load(), svc.GetState("ch"))
	}
	if budgetCalls.Load() != 1 {
		t.Fatalf("exact retry consumed budget: %d", budgetCalls.Load())
	}
	next := guardedCommand(t, svc, "play")
	next.URL = command.URL
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", next); err != nil {
		t.Fatal(err)
	}
	queue := svc.GetState("ch").Queue
	if len(queue) != 2 || queue[0].QueueItemID == queue[1].QueueItemID {
		t.Fatalf("intentional duplicate IDs: %#v", queue)
	}
	if err := svc.Skip("ch"); !errors.Is(err, ErrMusicProtocolRequired) {
		t.Fatalf("legacy downgrade=%v", err)
	}
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", MusicCommand{Action: "skip"}); !errors.Is(err, ErrMusicProtocolRequired) {
		t.Fatalf("partial downgrade=%v", err)
	}
}

func TestMusicControlOldSkipSeekAndStopNeverTouchReplacement(t *testing.T) {
	svc, _ := guardedMusicFixture(t)
	bot := svc.bots["ch"]
	var cancels atomic.Int32
	bot.cancelFn = func() { cancels.Add(1) }
	skip := guardedCommand(t, svc, "skip")
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", skip); err != nil {
		t.Fatal(err)
	}
	bot.sessionMu.Lock()
	bot.mu.Lock()
	bot.currentTrack = &models.MusicTrack{QueueItemID: uuid.NewString(), DurationSeconds: 100}
	bot.revision++
	bot.skipFlag = false
	bot.mu.Unlock()
	if err := svc.persistBot(bot); err != nil {
		t.Fatal(err)
	}
	bot.sessionMu.Unlock()
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", skip); err != nil {
		t.Fatal(err)
	}
	if cancels.Load() != 1 || bot.skipFlag {
		t.Fatalf("old skip touched next track: cancels=%d skip=%v", cancels.Load(), bot.skipFlag)
	}
	seek := guardedCommand(t, svc, "seek")
	seek.Seconds = 12
	wrong := "retired-track"
	seek.ExpectedQueueItemID = &wrong
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", seek); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("old-track seek=%v", err)
	}
	stop := guardedCommand(t, svc, "stop")
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", stop); err != nil {
		t.Fatal(err)
	}
	head, err := svc.AdoptControl(context.Background(), "ch")
	if err != nil {
		t.Fatal(err)
	}
	if head.SessionID == stop.SessionID {
		t.Fatal("stop did not rotate session")
	}
	replacement := &botInstance{channelID: "ch", serverID: "srv", sessionID: head.SessionID, revision: head.Revision, loopRunning: true}
	svc.mu.Lock()
	svc.bots["ch"] = replacement
	svc.mu.Unlock()
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", stop); err != nil {
		t.Fatal(err)
	}
	if svc.lookupBot("ch") != replacement || replacement.stopping.Load() {
		t.Fatal("stop retry affected replacement")
	}
	stop.RequestID = uuid.NewString()
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", stop); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("fresh stale stop=%v", err)
	}
}

func TestMusicControlTransientFailureHasNoSuccessReceipt(t *testing.T) {
	svc, store := guardedMusicFixture(t)
	command := guardedCommand(t, svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	var attempts int
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		attempts++
		if attempts == 1 {
			return nil, errors.New("transient extractor failure")
		}
		return []models.MusicTrack{{VideoID: "valid"}}, nil
	}
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", command); err == nil {
		t.Fatal("tool failure reported success")
	}
	result, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", command)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Added []models.MusicTrack `json:"added_tracks"`
	}
	if json.Unmarshal(result, &decoded) != nil || len(decoded.Added) != 1 || attempts != 2 {
		t.Fatalf("failed command was cached: %s attempts=%d", result, attempts)
	}
	head, err := store.MusicControlHead(context.Background(), "ch")
	if err != nil || head.Revision != 1 {
		t.Fatalf("failed tool advanced revision: %#v %v", head, err)
	}
}

func TestMusicControlFailedReceiptDoesNotApplyPlaybackEffect(t *testing.T) {
	svc, _ := guardedMusicFixture(t)
	bot := svc.bots["ch"]
	var cancellations atomic.Int32
	bot.cancelFn = func() { cancellations.Add(1) }
	for _, action := range []string{"pause", "skip", "seek", "stop"} {
		command := guardedCommand(t, svc, action)
		command.Seconds = 12
		before := svc.GetState("ch")
		// The unknown actor fails the receipt FK after its queue/head writes.
		if _, err := svc.ApplyMusicCommand(context.Background(), "missing-actor", "ch", command); err == nil {
			t.Fatalf("%s ignored receipt failure", action)
		}
		after := svc.GetState("ch")
		if after.SessionID != before.SessionID || after.Revision != before.Revision || after.IsPaused != before.IsPaused || cancellations.Load() != 0 || bot.seekRequested || bot.skipFlag || bot.stopping.Load() {
			t.Fatalf("%s applied effect before atomic commit", action)
		}
	}
}

type adoptDuringLegacyCheckStore struct {
	MusicSessionStore
	musicControlStore
	once           sync.Once
	afterFirstHead func()
}

func (s *adoptDuringLegacyCheckStore) MusicControlHead(ctx context.Context, id string) (*models.MusicControlHead, error) {
	head, err := s.musicControlStore.MusicControlHead(ctx, id)
	s.once.Do(s.afterFirstHead)
	return head, err // Deliberately return the pre-adoption lookup to the caller.
}

func TestMusicControlAdoptionWinningAfterLegacyPrecheckRejectsEveryMutation(t *testing.T) {
	for _, action := range []string{"skip", "pause", "resume", "seek", "remove", "reorder", "shuffle", "repeat"} {
		t.Run(action, func(t *testing.T) {
			svc, store := guardedMusicFixture(t)
			bot := svc.bots["ch"]
			a, b := uuid.NewString(), uuid.NewString()
			bot.queue = []models.MusicTrack{{QueueItemID: a}, {QueueItemID: b}}
			var cancelCalls atomic.Int32
			bot.cancelFn = func() { cancelCalls.Add(1) }
			wrapper := &adoptDuringLegacyCheckStore{MusicSessionStore: svc.sessions, musicControlStore: store}
			wrapper.afterFirstHead = func() {
				if _, err := svc.AdoptControl(context.Background(), "ch"); err != nil {
					t.Fatal(err)
				}
			}
			svc.sessions = wrapper
			var err error
			switch action {
			case "skip":
				err = svc.Skip("ch")
			case "pause":
				err = svc.Pause("ch")
			case "resume":
				err = svc.Resume("ch")
			case "seek":
				err = svc.Seek("ch", 12)
			case "remove":
				err = svc.RemoveQueueItem("ch", a, 0)
			case "reorder":
				err = svc.ReorderQueue("ch", []string{b, a}, 0)
			case "shuffle":
				err = svc.ShuffleQueue("ch", 0)
			case "repeat":
				err = svc.SetRepeatMode("ch", "all")
			}
			if !errors.Is(err, ErrMusicProtocolRequired) {
				t.Fatalf("legacy %s after adoption=%v", action, err)
			}
			state := svc.GetState("ch")
			if state.Revision != 0 || state.IsPaused || len(state.Queue) != 2 || state.Queue[0].QueueItemID != a || state.Queue[1].QueueItemID != b || state.RepeatMode != "" || bot.skipFlag || bot.seekRequested || cancelCalls.Load() != 0 {
				t.Fatalf("legacy %s mutated adopted state: %#v", action, state)
			}
		})
	}
}

func TestMusicControlStopDuringExtractionDoesNotReconnectStaleSession(t *testing.T) {
	svc, _ := guardedMusicFixture(t)
	play := guardedCommand(t, svc, "play")
	play.URL = "https://youtu.be/0KbRhUtFwkc"
	started, release := make(chan struct{}), make(chan struct{})
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		close(started)
		<-release
		return []models.MusicTrack{{VideoID: "stale"}}, nil
	}
	var connects atomic.Int32
	svc.connectBotFn = func(context.Context, *botInstance) error { connects.Add(1); return nil }
	done := make(chan error, 1)
	go func() { _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", play); done <- err }()
	<-started
	stop := guardedCommand(t, svc, "stop")
	if _, err := svc.ApplyMusicCommand(context.Background(), "actor", "ch", stop); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale enqueue=%v", err)
	}
	if connects.Load() != 0 || svc.lookupBot("ch") != nil {
		t.Fatalf("stale extraction reconnected a replacement: %d", connects.Load())
	}
}

type failedMusicHeadStore struct {
	MusicSessionStore
	musicControlStore
}

func (failedMusicHeadStore) MusicControlHead(context.Context, string) (*models.MusicControlHead, error) {
	return nil, errors.New("injected durable head read failure")
}

func TestMusicControlInactiveStatePropagatesStoreFailure(t *testing.T) {
	svc, store := guardedMusicFixture(t)
	svc.bots = map[string]*botInstance{}
	svc.sessions = failedMusicHeadStore{svc.sessions, store}
	if state, err := svc.GetStateWithError(context.Background(), "ch"); err == nil || state != nil {
		t.Fatalf("store failure reported inactive success: %#v %v", state, err)
	}
}
