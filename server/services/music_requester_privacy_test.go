package services

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
)

type musicRequesterObserverFunc func(string)

func (f musicRequesterObserverFunc) AnonymizeMusicRequester(id string) { f(id) }

func musicPrivacyFixture(t *testing.T, protocol2 ...bool) (*mfaHarness, *authService, *AuthTokens, *musicBotService) {
	t.Helper()
	h, auth, _ := boundAuthHarness(t)
	auth.accountAnonymization = repository.NewSQLiteAccountAnonymizationRepo(h.db.Conn)
	login := sessionLogin(t, auth, h.user.Username)
	for _, q := range []string{`INSERT INTO users(id,username,password_hash) VALUES('other','othername','hash')`, `INSERT INTO servers(id,name,owner_id) VALUES('srv','Music','other')`, `INSERT INTO channels(id,name,type,server_id) VALUES('ch','Music','voice','srv')`} {
		if _, err := h.db.Conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	svc := newTestMusicBotService("ch", "srv")
	svc.restored = map[string]models.MusicSession{}
	svc.sessions = repository.NewSQLiteMusicSessionRepo(h.db.Conn)
	svc.users = repository.NewSQLiteUserRepo(h.db.Conn)
	bot := svc.bots["ch"]
	bot.currentTrack = &models.MusicTrack{QueueItemID: uuid.NewString(), VideoID: "current", Title: h.user.Username, RequestedByUserID: h.user.ID, RequestedByName: h.user.Username, DurationSeconds: 100}
	bot.revision = 5
	bot.repeatMode = "one"
	bot.queue = []models.MusicTrack{{QueueItemID: uuid.NewString(), VideoID: "pending", RequestedByUserID: h.user.ID, RequestedByName: h.user.Username}, {QueueItemID: uuid.NewString(), VideoID: "other", RequestedByUserID: "other", RequestedByName: h.user.Username}}
	bot.user = &requesterMeta{userID: h.user.ID, name: h.user.Username}
	if err := svc.persistBot(bot); err != nil {
		t.Fatal(err)
	}
	if len(protocol2) == 0 || protocol2[0] {
		if _, err := svc.AdoptControl(context.Background(), "ch"); err != nil {
			t.Fatal(err)
		}
	}
	auth.SetMusicRequesterRetirementObserver(svc)
	return h, auth, login, svc
}

func TestMusicRequesterPrivacySlowEnqueueCannotReintroduceDeletedName(t *testing.T) {
	h, auth, login, svc := musicPrivacyFixture(t)
	before := svc.GetState("ch")
	command := guardedCommand(t, svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	svc.extractTracksFn = func(_ context.Context, _ string, id, name string) ([]models.MusicTrack, error) {
		if name != h.user.Username {
			t.Errorf("fixture did not capture old requester name: %q", name)
		}
		close(started)
		<-release
		return []models.MusicTrack{{VideoID: "new", RequestedByUserID: id, RequestedByName: name}}, nil
	}
	done := make(chan error, 1)
	go func() { _, err := svc.ApplyMusicCommand(context.Background(), h.user.ID, "ch", command); done <- err }()
	<-started
	if err := auth.DeleteAccount(context.Background(), h.user.ID, login.SessionID, "current-password", ""); err != nil {
		t.Fatal(err)
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrUnauthorized) {
			t.Fatalf("retired in-flight actor=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("slow enqueue/deletion deadlocked")
	}
	after := svc.GetState("ch")
	if after.SessionID != before.SessionID || after.Revision != before.Revision || len(after.Queue) != len(before.Queue) || after.CurrentTrack.QueueItemID != before.CurrentTrack.QueueItemID {
		t.Fatal("privacy retirement changed playback control state")
	}
	if after.CurrentTrack.RequestedByName != "Deleted User" || after.Queue[0].RequestedByName != "Deleted User" || after.Queue[1].RequestedByName != h.user.Username || after.CurrentTrack.Title != h.user.Username {
		t.Fatalf("wrong identity fields sanitized: %#v", after)
	}
	bot := svc.bots["ch"]
	if bot.user.name != "Deleted User" {
		t.Fatal("requesterMeta retained old identity")
	}
}

func TestMusicRequesterPrivacyRepeatLocalCopyAndPublicSnapshots(t *testing.T) {
	h, auth, login, svc := musicPrivacyFixture(t)
	bot := svc.bots["ch"]
	oldLocal := *bot.currentTrack
	beforeQueue := cloneMusicTracks(bot.queue)
	if err := auth.DeleteAccount(context.Background(), h.user.ID, login.SessionID, "current-password", ""); err != nil {
		t.Fatal(err)
	}
	svc.repeatCompletedTrack(bot, oldLocal)
	state := svc.GetState("ch")
	if len(state.Queue) != len(beforeQueue)+1 || state.Queue[0].QueueItemID != oldLocal.QueueItemID || state.Queue[0].RequestedByName != "Deleted User" || state.Queue[0].RequestedByUserID != h.user.ID || state.Queue[2].RequestedByName != h.user.Username {
		t.Fatalf("repeat copy resurrected metadata: %#v", state.Queue)
	}
	rows, err := svc.sessions.List(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("durable queue read: %#v %v", rows, err)
	}
	for _, track := range rows[0].Queue {
		if track.RequestedByUserID == h.user.ID && track.RequestedByName != "Deleted User" {
			t.Fatalf("stale repeat persisted: %#v", track)
		}
	}
	// Public serialization must also sanitize legacy/stale cache content even
	// when it was captured independently of the retirement observer.
	bot.mu.Lock()
	bot.queue[0].RequestedByName = h.user.Username
	bot.currentTrack.RequestedByName = h.user.Username
	bot.mu.Unlock()
	var published *models.MusicBotChannelState
	svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, event ws.Event) {
		published = event.Data.(map[string]any)["state"].(*models.MusicBotChannelState)
	}}
	svc.broadcastState(bot)
	if published == nil || published.Queue[0].RequestedByName != "Deleted User" || published.CurrentTrack.RequestedByName != "Deleted User" {
		t.Fatal("public snapshot leaked stale cache name")
	}
}

func TestMusicRequesterPrivacyDeletionFailureRollsBackWithoutRuntimeObserver(t *testing.T) {
	h, auth, login, svc := musicPrivacyFixture(t)
	before := svc.GetState("ch")
	rows, err := svc.sessions.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	beforeQueue := rows[0]
	var calls atomic.Int32
	auth.SetMusicRequesterRetirementObserver(musicRequesterObserverFunc(func(id string) { calls.Add(1); svc.AnonymizeMusicRequester(id) }))
	if _, err := h.db.Conn.Exec(`CREATE TRIGGER deny_music_retirement BEFORE UPDATE OF deleted_at ON users BEGIN SELECT RAISE(ABORT,'injected retirement failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := auth.DeleteAccount(context.Background(), h.user.ID, login.SessionID, "current-password", ""); err == nil {
		t.Fatal("deletion failure reported success")
	}
	after := svc.GetState("ch")
	rows, err = svc.sessions.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeQueue, rows[0]) {
		t.Fatal("failed deletion altered runtime/durable queue")
	}
}

func TestMusicRequesterPrivacyPublicationFenceOrdersEqualRevisionReplacement(t *testing.T) {
	h, auth, login, svc := musicPrivacyFixture(t)
	captured, release, observerStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	var mu sync.Mutex
	names := []string{}
	consume := func(state *models.MusicBotChannelState) {
		encoded, err := json.Marshal(state)
		if err != nil {
			t.Error(err)
		}
		var copy models.MusicBotChannelState
		if json.Unmarshal(encoded, &copy) != nil {
			t.Error("bad snapshot")
		}
		mu.Lock()
		names = append(names, copy.CurrentTrack.RequestedByName)
		mu.Unlock()
	}
	svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, event ws.Event) {
		consume(event.Data.(map[string]any)["state"].(*models.MusicBotChannelState))
	}}
	getDone := make(chan error, 1)
	go func() {
		getDone <- svc.WithPublicMusicState(context.Background(), "ch", func(state *models.MusicBotChannelState) { close(captured); <-release; consume(state) })
	}()
	<-captured
	auth.SetMusicRequesterRetirementObserver(musicRequesterObserverFunc(func(id string) { close(observerStarted); svc.AnonymizeMusicRequester(id) }))
	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- auth.DeleteAccount(context.Background(), h.user.ID, login.SessionID, "current-password", "")
	}()
	select {
	case <-observerStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("retirement did not commit")
	}
	select {
	case err := <-deleteDone:
		t.Fatalf("deletion returned before old publication drained: %v", err)
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-getDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("GET publication deadlocked")
	}
	select {
	case err := <-deleteDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("retirement publication deadlocked")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(names) != 2 || names[0] != h.user.Username || names[1] != "Deleted User" {
		t.Fatalf("late old snapshot overwrote anonymized state: %#v", names)
	}
}

type failingMusicIdentityStore struct {
	MusicSessionStore
	musicControlStore
}

func (failingMusicIdentityStore) SanitizeMusicTracks(context.Context, []models.MusicTrack) ([]models.MusicTrack, error) {
	return nil, errors.New("injected identity lookup failure")
}

func TestMusicRequesterPrivacyIdentityLookupFailureNeverPublishesOldName(t *testing.T) {
	_, _, _, svc := musicPrivacyFixture(t)
	svc.sessions = failingMusicIdentityStore{svc.sessions, svc.sessions.(musicControlStore)}
	var publications atomic.Int32
	svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { publications.Add(1) }}
	if state, err := svc.GetStateWithError(context.Background(), "ch"); err == nil || state != nil {
		t.Fatalf("identity failure returned stale snapshot: %#v %v", state, err)
	}
	svc.broadcastState(svc.bots["ch"])
	if publications.Load() != 0 {
		t.Fatal("identity failure broadcast a stale requester name")
	}
}

func TestMusicRequesterPrivacyAlreadyCanonicalCacheStillPublishesReplacement(t *testing.T) {
	svc := newTestMusicBotService("ch", "srv")
	svc.bots["ch"].queue = []models.MusicTrack{{QueueItemID: "same-item", RequestedByUserID: "retired", RequestedByName: "Deleted User"}}
	var publications int
	svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { publications++ }}
	svc.AnonymizeMusicRequester("retired")
	if publications != 1 || svc.GetState("ch").Revision != 0 || svc.GetState("ch").Queue[0].QueueItemID != "same-item" {
		t.Fatal("already canonical cache did not fence a replacement for older deliveries")
	}
}
