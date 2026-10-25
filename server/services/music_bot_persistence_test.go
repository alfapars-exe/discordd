package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type memoryMusicSessions struct {
	mu             sync.Mutex
	items          map[string]models.MusicSession
	failNext       int
	failDeleteNext int
	saveCalls      int
	savedRevisions []uint64
}

type blockingDeleteMusicSessions struct {
	*memoryMusicSessions
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (m *blockingDeleteMusicSessions) Delete(ctx context.Context, channelID string) error {
	first := false
	m.once.Do(func() { close(m.started); first = true })
	if !first {
		return m.memoryMusicSessions.Delete(ctx, channelID)
	}
	select {
	case <-m.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	return m.memoryMusicSessions.Delete(ctx, channelID)
}

func (m *memoryMusicSessions) List(context.Context) ([]models.MusicSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]models.MusicSession, 0, len(m.items))
	for _, item := range m.items {
		result = append(result, item)
	}
	return result, nil
}
func (m *memoryMusicSessions) Save(_ context.Context, item models.MusicSession) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saveCalls++
	if m.failNext > 0 {
		m.failNext--
		return errors.New("injected session save failure")
	}
	m.savedRevisions = append(m.savedRevisions, item.Revision)
	m.items[item.ChannelID] = item
	return nil
}
func (m *memoryMusicSessions) Delete(_ context.Context, channelID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failDeleteNext > 0 {
		m.failDeleteNext--
		return errors.New("injected session delete failure")
	}
	delete(m.items, channelID)
	return nil
}

func TestStopDeleteFailureKeepsRestoredSessionForRetry(t *testing.T) {
	session := models.MusicSession{ChannelID: "ch", ServerID: "srv", Revision: 4, Queue: []models.MusicTrack{{QueueItemID: "item", Title: "Track"}}}
	store := &memoryMusicSessions{items: map[string]models.MusicSession{"ch": session}, failDeleteNext: 1}
	svc := &musicBotService{bots: make(map[string]*botInstance), restored: map[string]models.MusicSession{"ch": session}, sessions: store}

	if err := svc.Stop("ch"); err == nil {
		t.Fatal("first stop succeeded despite injected delete failure")
	}
	if state := svc.GetState("ch"); state == nil || state.Revision != session.Revision || len(state.Queue) != 1 || state.Queue[0].QueueItemID != "item" {
		t.Fatalf("failed stop lost the in-memory restored queue: %#v", state)
	}
	store.mu.Lock()
	_, stillPersisted := store.items["ch"]
	store.mu.Unlock()
	if !stillPersisted {
		t.Fatal("failed stop unexpectedly removed the durable session")
	}

	if err := svc.Stop("ch"); err != nil {
		t.Fatalf("stop retry failed: %v", err)
	}
	if state := svc.GetState("ch"); state != nil {
		t.Fatalf("successful stop left restored state: %#v", state)
	}
	store.mu.Lock()
	_, stillPersisted = store.items["ch"]
	store.mu.Unlock()
	if stillPersisted {
		t.Fatal("successful stop did not delete the durable session")
	}
}

func TestRestoreAbortsWhenStopClearsSnapshottedRestoredSession(t *testing.T) {
	session := models.MusicSession{ChannelID: "ch", ServerID: "srv", Revision: 5, Queue: []models.MusicTrack{{QueueItemID: "item", Title: "Track"}}}
	store := &memoryMusicSessions{items: map[string]models.MusicSession{"ch": session}}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	snapshotTaken := make(chan struct{})
	releaseRestore := make(chan struct{})
	svc.restoreSnapshotFn = func() {
		close(snapshotTaken)
		<-releaseRestore
	}
	var connects int
	svc.connectBotFn = func(context.Context, *botInstance) error { connects++; return nil }

	restoreDone := make(chan error, 1)
	go func() { restoreDone <- svc.Restore(context.Background(), "ch") }()
	select {
	case <-snapshotTaken:
	case <-time.After(time.Second):
		t.Fatal("Restore did not reach the snapshot seam")
	}
	if err := svc.Stop("ch"); err != nil {
		t.Fatalf("Stop botless restored session: %v", err)
	}
	close(releaseRestore)
	select {
	case err := <-restoreDone:
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("Restore = %v, want not found after Stop", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Restore remained blocked after stale session was stopped")
	}
	if connects != 0 {
		t.Fatalf("stale Restore opened %d LiveKit connection(s)", connects)
	}
	if bot := svc.lookupBot("ch"); bot != nil {
		t.Fatalf("stale Restore left bot connected: %#v", bot)
	}
	store.mu.Lock()
	_, stillStored := store.items["ch"]
	store.mu.Unlock()
	if stillStored {
		t.Fatal("Stop did not delete the durable restored session")
	}
}

func TestFailedEnqueueKeepsRestoredQueuePausedAndRestorable(t *testing.T) {
	oldTrack := models.MusicTrack{QueueItemID: "00000000-0000-4000-8000-000000000001", VideoID: "old", Title: "Restored"}
	store := &memoryMusicSessions{items: map[string]models.MusicSession{
		"ch": {ChannelID: "ch", ServerID: "srv", Queue: []models.MusicTrack{oldTrack}, Revision: 7, RepeatMode: "all"},
	}, failNext: 1}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	svc.connectBotFn = func(context.Context, *botInstance) error { return nil }
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "new", Title: "New"}}, nil
	}
	playbackStarted := make(chan struct{})
	playbackRelease := make(chan struct{})
	svc.playTrackFn = func(_ *botInstance, track *models.MusicTrack) error {
		if track.QueueItemID != oldTrack.QueueItemID {
			t.Errorf("retry played non-restored track first: %#v", track)
		}
		close(playbackStarted)
		<-playbackRelease
		return nil
	}
	defer func() {
		close(playbackRelease)
		_ = svc.Stop("ch")
	}()

	if _, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk"); err == nil {
		t.Fatal("enqueue succeeded despite injected persistence failure")
	}
	if svc.lookupBot("ch") != nil {
		t.Fatal("failed enqueue left a connected bot hiding the paused session")
	}
	state := svc.GetState("ch")
	if state == nil || state.IsActive || !state.IsPaused || state.Revision != 7 || len(state.Queue) != 1 || state.Queue[0].QueueItemID != oldTrack.QueueItemID || state.RepeatMode != "all" {
		t.Fatalf("failed enqueue did not preserve paused restored state: %#v", state)
	}
	if err := svc.Restore(context.Background(), "ch"); err != nil {
		t.Fatalf("Restore after failed enqueue: %v", err)
	}
	select {
	case <-playbackStarted:
	case <-time.After(time.Second):
		t.Fatal("restored queue did not start after explicit restore")
	}
	state = svc.GetState("ch")
	if state == nil || state.CurrentTrack == nil || state.CurrentTrack.QueueItemID != oldTrack.QueueItemID {
		t.Fatalf("Restore did not resume the retained track: %#v", state)
	}
}

func TestStopSerializesRestoredDeleteAgainstConcurrentEnqueue(t *testing.T) {
	base := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	store := &blockingDeleteMusicSessions{memoryMusicSessions: base, started: make(chan struct{}), release: make(chan struct{})}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	svc.connectBotFn = func(context.Context, *botInstance) error { return nil }
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "video", Title: "Track"}}, nil
	}
	playbackStarted := make(chan struct{})
	playbackRelease := make(chan struct{})
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error {
		close(playbackStarted)
		<-playbackRelease
		return nil
	}
	defer func() {
		close(playbackRelease)
		_ = svc.Stop("ch")
	}()

	stopDone := make(chan error, 1)
	go func() { stopDone <- svc.Stop("ch") }()
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("Stop did not reach the durable delete")
	}

	extracted := make(chan struct{})
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		close(extracted)
		return []models.MusicTrack{{VideoID: "video", Title: "Track"}}, nil
	}
	type enqueueResult struct {
		tracks []models.MusicTrack
		err    error
	}
	enqueueDone := make(chan enqueueResult, 1)
	go func() {
		tracks, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
		enqueueDone <- enqueueResult{tracks: tracks, err: err}
	}()
	select {
	case <-extracted:
	case <-time.After(time.Second):
		t.Fatal("enqueue did not finish track extraction")
	}
	select {
	case result := <-enqueueDone:
		t.Fatalf("enqueue passed the in-flight Stop delete: tracks=%#v err=%v", result.tracks, result.err)
	case <-time.After(50 * time.Millisecond):
	}
	close(store.release)
	if err := <-stopDone; err != nil {
		t.Fatalf("Stop failed: %v", err)
	}
	result := <-enqueueDone
	if result.err != nil || len(result.tracks) != 1 {
		t.Fatalf("enqueue after Stop failed: tracks=%#v err=%v", result.tracks, result.err)
	}
	select {
	case <-playbackStarted:
	case <-time.After(time.Second):
		t.Fatal("acknowledged enqueue did not start playback")
	}
	base.mu.Lock()
	stored, ok := base.items["ch"]
	base.mu.Unlock()
	if !ok || len(stored.Queue) != 1 || stored.Queue[0].QueueItemID != result.tracks[0].QueueItemID {
		t.Fatalf("acknowledged queue item was lost from durable storage: stored=%#v exists=%v result=%#v", stored, ok, result.tracks)
	}
}

func TestEnqueueAppendsToRestoredPausedQueue(t *testing.T) {
	oldTrack := models.MusicTrack{QueueItemID: "00000000-0000-4000-8000-000000000001", VideoID: "old", Title: "Restored"}
	store := &memoryMusicSessions{items: map[string]models.MusicSession{
		"ch": {ChannelID: "ch", ServerID: "srv", Queue: []models.MusicTrack{oldTrack}, Revision: 7, RepeatMode: "all"},
	}}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	svc.connectBotFn = func(context.Context, *botInstance) error { return nil }
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "new", Title: "New"}}, nil
	}
	playbackStarted := make(chan struct{})
	playbackRelease := make(chan struct{})
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error {
		close(playbackStarted)
		<-playbackRelease
		return nil
	}
	defer func() {
		close(playbackRelease)
		_ = svc.Stop("ch")
	}()

	newTracks, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
	if err != nil || len(newTracks) != 1 {
		t.Fatalf("enqueue = %#v, %v", newTracks, err)
	}
	select {
	case <-playbackStarted:
	case <-time.After(time.Second):
		t.Fatal("enqueue did not begin the restored queue")
	}
	state := svc.GetState("ch")
	if state == nil || state.CurrentTrack == nil || state.CurrentTrack.QueueItemID != oldTrack.QueueItemID || len(state.Queue) != 1 || state.Queue[0].QueueItemID != newTracks[0].QueueItemID || state.RepeatMode != "all" {
		t.Fatalf("enqueue overwrote or lost restored session data: %#v", state)
	}
	store.mu.Lock()
	stored := store.items["ch"]
	store.mu.Unlock()
	if stored.Revision <= 7 || len(stored.Queue) != 2 || stored.Queue[0].QueueItemID != oldTrack.QueueItemID || stored.Queue[1].QueueItemID != newTracks[0].QueueItemID || stored.RepeatMode != "all" {
		t.Fatalf("durable session did not reconcile restored and new tracks: %#v", stored)
	}
}

func TestMusicSessionLoadsPausedWithoutConnecting(t *testing.T) {
	store := &memoryMusicSessions{items: map[string]models.MusicSession{"ch": {
		ChannelID: "ch", ServerID: "srv", RepeatMode: "all", Revision: 9,
		Queue: []models.MusicTrack{{QueueItemID: "00000000-0000-4000-8000-000000000001", Title: "Interrupted"}},
	}}}
	svc := NewMusicBotService(&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}}, nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil).(*musicBotService)
	connected := 0
	svc.connectBotFn = func(context.Context, *botInstance) error { connected++; return nil }
	state := svc.GetState("ch")
	if connected != 0 || state == nil || state.IsActive || !state.IsPaused || state.RepeatMode != "all" || state.Revision != 9 || len(state.Queue) != 1 {
		t.Fatalf("connected=%d state=%#v", connected, state)
	}
}

func TestEnqueueSaveFailureRollsBackAndRetryStartsPlayback(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession), failNext: 1}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	svc.connectBotFn = func(context.Context, *botInstance) error { return nil }
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "video", Title: "Track"}}, nil
	}
	started := make(chan struct{})
	release := make(chan struct{})
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error {
		close(started)
		<-release
		return nil
	}
	defer func() {
		close(release)
		svc.Stop("ch")
	}()

	if _, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk"); err == nil {
		t.Fatal("first enqueue succeeded despite injected persistence failure")
	}
	bot := svc.lookupBot("ch")
	if bot == nil {
		t.Fatal("failed enqueue unexpectedly discarded the reusable bot")
	}
	bot.mu.Lock()
	if len(bot.queue) != 0 || bot.revision != 0 || bot.loopRunning {
		t.Fatalf("failed enqueue left partial state: queue=%#v revision=%d loop=%v", bot.queue, bot.revision, bot.loopRunning)
	}
	bot.mu.Unlock()
	if state := svc.GetState("ch"); state == nil || len(state.Queue) != 0 {
		t.Fatalf("failed enqueue was still visible: %#v", state)
	}

	tracks, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
	if err != nil || len(tracks) != 1 {
		t.Fatalf("retry enqueue = %#v, %v", tracks, err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("successful retry did not start playback")
	}
	state := svc.GetState("ch")
	if state == nil || state.CurrentTrack == nil || state.CurrentTrack.QueueItemID != tracks[0].QueueItemID {
		t.Fatalf("retry did not play the durably accepted queue item: %#v", state)
	}
	store.mu.Lock()
	stored := store.items["ch"]
	store.mu.Unlock()
	if len(stored.Queue) != 1 || stored.Queue[0].QueueItemID != tracks[0].QueueItemID {
		t.Fatalf("durable session differs from accepted retry: %#v", stored)
	}
}

func TestEnqueueConnectPanicReleasesChannelLifecycleLock(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}},
		nil, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, nil, nil, store, nil,
	).(*musicBotService)
	var attempts int
	svc.connectBotFn = func(context.Context, *botInstance) error {
		attempts++
		if attempts == 1 {
			panic("injected connect panic")
		}
		return nil
	}
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "video", Title: "Track"}}, nil
	}
	playbackStarted := make(chan struct{})
	playbackRelease := make(chan struct{})
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error {
		close(playbackStarted)
		<-playbackRelease
		return nil
	}
	defer func() {
		close(playbackRelease)
		_ = svc.Stop("ch")
	}()

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("first enqueue did not propagate connect panic")
			}
		}()
		_, _ = svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
	}()

	result := make(chan error, 1)
	go func() {
		tracks, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
		if err == nil && len(tracks) != 1 {
			err = errors.New("retry enqueue returned no accepted track")
		}
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("enqueue after recovered connect panic failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue after recovered connect panic blocked on leaked lifecycle lock")
	}
	select {
	case <-playbackStarted:
	case <-time.After(time.Second):
		t.Fatal("successful retry did not start playback")
	}
}

func TestConcurrentEnqueueSnapshotsRemainMonotonicAndKeepEveryQueueID(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	svc := newTestMusicBotService("ch", "srv")
	svc.sessions = store
	svc.bots["ch"].currentTrack = nil
	svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "same-video", Title: "Duplicate"}}, nil
	}
	const count = 3
	start := make(chan struct{})
	results := make(chan []models.MusicTrack, count)
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			tracks, err := svc.Enqueue(context.Background(), "user", "ch", "https://youtu.be/abcdefghijk")
			results <- tracks
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	ids := make(map[string]struct{}, count)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent enqueue failed: %v", err)
		}
	}
	for tracks := range results {
		if len(tracks) != 1 {
			t.Fatalf("concurrent enqueue returned %#v", tracks)
		}
		ids[tracks[0].QueueItemID] = struct{}{}
	}
	state := svc.GetState("ch")
	if state.Revision != count || len(state.Queue) != count || len(ids) != count {
		t.Fatalf("concurrent state lost an enqueue: revision=%d queue=%#v ids=%d", state.Revision, state.Queue, len(ids))
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	stored := store.items["ch"]
	if stored.Revision != count || len(stored.Queue) != count {
		t.Fatalf("durable concurrent state = revision %d queue %#v", stored.Revision, stored.Queue)
	}
	for i := 1; i < len(store.savedRevisions); i++ {
		if store.savedRevisions[i] < store.savedRevisions[i-1] {
			t.Fatalf("session writes regressed: %v", store.savedRevisions)
		}
	}
}

func TestUnexpectedDisconnectSnapshotPreservesInterruptedTrack(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	current := models.MusicTrack{QueueItemID: "current", VideoID: "one", Title: "Playing"}
	pending := models.MusicTrack{QueueItemID: "pending", VideoID: "two", Title: "Next"}
	bot := &botInstance{
		channelID: "ch", serverID: "srv", currentTrack: &current,
		queue: []models.MusicTrack{pending}, repeatMode: "all", revision: 12,
		ready: make(chan struct{}),
	}
	close(bot.ready)
	svc := &musicBotService{
		bots: map[string]*botInstance{"ch": bot}, restored: make(map[string]models.MusicSession),
		sessions: store, hub: &testutil.MockBroadcaster{},
	}

	svc.StopAllForChannel("ch")

	state := svc.GetState("ch")
	if state == nil || state.IsActive || !state.IsPaused || state.Revision != 12 || state.RepeatMode != "all" || len(state.Queue) != 2 {
		t.Fatalf("restored state=%#v", state)
	}
	if state.Queue[0].QueueItemID != "current" || state.Queue[1].QueueItemID != "pending" {
		t.Fatalf("queue=%#v", state.Queue)
	}
	store.mu.Lock()
	persisted := store.items["ch"]
	store.mu.Unlock()
	if len(persisted.Queue) != 2 || persisted.Queue[0].QueueItemID != "current" {
		t.Fatalf("persisted=%#v", persisted)
	}
}

func TestSeekFiniteTrackRequestsReplayAndRejectsLive(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	track := models.MusicTrack{QueueItemID: "current", VideoID: "one", Title: "Playing", DurationSeconds: 180}
	bot := &botInstance{channelID: "ch", serverID: "srv", currentTrack: &track, revision: 4}
	svc := &musicBotService{
		bots: map[string]*botInstance{"ch": bot}, restored: make(map[string]models.MusicSession),
		sessions: store, hub: &testutil.MockBroadcaster{},
	}
	if err := svc.Seek("ch", 75); err != nil {
		t.Fatal(err)
	}
	bot.mu.Lock()
	requested, target, revision := bot.seekRequested, bot.seekTarget, bot.revision
	bot.mu.Unlock()
	if !requested || target != 75*time.Second || revision != 5 {
		t.Fatalf("requested=%v target=%v revision=%d", requested, target, revision)
	}
	if !svc.prepareSeekReplay(bot) {
		t.Fatal("seek replay not consumed")
	}
	bot.mu.Lock()
	offset, elapsed := bot.playbackOffset, bot.elapsed
	bot.mu.Unlock()
	if offset != 75*time.Second || elapsed != 75*time.Second {
		t.Fatalf("offset=%v elapsed=%v", offset, elapsed)
	}

	bot.mu.Lock()
	bot.currentTrack.DurationSeconds = 0
	bot.mu.Unlock()
	if err := svc.Seek("ch", 1); err == nil {
		t.Fatal("live track seek unexpectedly succeeded")
	}
}

func TestPlayTrackYtdlpArgsSeekUsesBoundedDownloadSection(t *testing.T) {
	args := playTrackYtdlpArgs("https://www.youtube.com/watch?v=BaW_jenozKc", 75*time.Second)
	assertHasAdjacentPair(t, args, "--download-sections", "*75-inf")
	if args[len(args)-2] != "--" || args[len(args)-1] != "https://www.youtube.com/watch?v=BaW_jenozKc" {
		t.Fatalf("URL is not isolated at argv tail: %q", args)
	}
}

func TestPlayLoopSeekReplaysCurrentItemWithoutAdvancingQueue(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	bot := &botInstance{
		channelID: "ch", serverID: "srv", loopRunning: true,
		queue: []models.MusicTrack{{QueueItemID: "current", VideoID: "one", Title: "Playing", DurationSeconds: 180}},
	}
	svc := &musicBotService{
		bots: map[string]*botInstance{"ch": bot}, restored: make(map[string]models.MusicSession),
		sessions: store, hub: &testutil.MockBroadcaster{},
	}
	calls := 0
	svc.playTrackFn = func(instance *botInstance, _ *models.MusicTrack) error {
		calls++
		if calls == 1 {
			return svc.Seek(instance.channelID, 30)
		}
		instance.mu.Lock()
		offset := instance.playbackOffset
		instance.mu.Unlock()
		if offset != 30*time.Second {
			t.Fatalf("replay offset=%v", offset)
		}
		return nil
	}

	svc.playLoop(bot)
	if calls != 2 {
		t.Fatalf("play calls=%d, want 2", calls)
	}
}

func TestDisconnectedPublisherReconnectsWithBoundedRetries(t *testing.T) {
	store := &memoryMusicSessions{items: make(map[string]models.MusicSession)}
	session := models.MusicSession{ChannelID: "ch", ServerID: "srv", Queue: []models.MusicTrack{{QueueItemID: "one", Title: "Track"}}}
	svc := &musicBotService{
		bots: make(map[string]*botInstance), restored: map[string]models.MusicSession{"ch": session},
		sessions: store, hub: &testutil.MockBroadcaster{}, reconnectDelaysOverride: []time.Duration{0, time.Millisecond, time.Millisecond},
	}
	attempts := 0
	svc.connectBotFn = func(context.Context, *botInstance) error {
		attempts++
		if attempts < 3 {
			return errors.New("temporary LiveKit outage")
		}
		return nil
	}
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error { return nil }

	svc.recoverDisconnectedBot("ch")
	if attempts != 3 {
		t.Fatalf("attempts=%d", attempts)
	}
	svc.mu.RLock()
	_, pending := svc.restored["ch"]
	svc.mu.RUnlock()
	if pending {
		t.Fatal("restored queue remained after successful reconnect")
	}
}

func TestDisconnectedPublisherExhaustionKeepsPausedQueue(t *testing.T) {
	session := models.MusicSession{ChannelID: "ch", ServerID: "srv", Queue: []models.MusicTrack{{QueueItemID: "one", Title: "Track"}}}
	svc := &musicBotService{
		bots: make(map[string]*botInstance), restored: map[string]models.MusicSession{"ch": session},
		hub: &testutil.MockBroadcaster{}, reconnectDelaysOverride: []time.Duration{0, time.Millisecond},
	}
	attempts := 0
	svc.connectBotFn = func(context.Context, *botInstance) error { attempts++; return errors.New("offline") }
	svc.recoverDisconnectedBot("ch")
	if attempts != 2 || svc.GetState("ch") == nil || !svc.GetState("ch").IsPaused {
		t.Fatalf("attempts=%d state=%#v", attempts, svc.GetState("ch"))
	}
}
