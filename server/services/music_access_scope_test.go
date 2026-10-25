package services

import (
	"context"
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
)

type musicScopeFixture struct {
	h          *mfaHarness
	auth       *authService
	login      *AuthTokens
	svc        *musicBotService
	voice      *voiceService
	joined     time.Time
	permission atomic.Bool
}

func newMusicScopeFixture(t *testing.T, paused bool, protocol2 ...bool) *musicScopeFixture {
	t.Helper()
	h, auth, login, svc := musicPrivacyFixture(t, protocol2...)
	if _, err := h.db.Conn.Exec(`INSERT INTO server_members(server_id,user_id) VALUES('srv',?)`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	joined := time.Unix(1000, 1)
	f := &musicScopeFixture{h: h, auth: auth, login: login, svc: svc, joined: joined, voice: &voiceService{states: map[string]*models.VoiceState{h.user.ID: {UserID: h.user.ID, ServerID: "srv", ChannelID: "ch", JoinedAt: joined}}}}
	f.permission.Store(true)
	svc.extractTracksFn = func(_ context.Context, _ string, id, name string) ([]models.MusicTrack, error) {
		return []models.MusicTrack{{VideoID: "added", URL: "https://youtu.be/0KbRhUtFwkc", RequestedByUserID: id, RequestedByName: name}}, nil
	}
	playRelease := make(chan struct{})
	var playReleaseOnce sync.Once
	svc.playTrackFn = func(*botInstance, *models.MusicTrack) error { <-playRelease; return nil }
	t.Cleanup(func() { svc.StopAllForChannel("ch"); playReleaseOnce.Do(func() { close(playRelease) }) })
	if paused {
		svc.StopAllForChannel("ch")
	}
	return f
}

func (f *musicScopeFixture) context() context.Context {
	initial := f.voice.GetUserVoiceState(f.h.user.ID)
	var generation uint64
	if initial != nil {
		generation = initial.ChannelGeneration
	}
	return WithMusicAccessCheck(context.Background(), func(ctx context.Context) error {
		if err := f.auth.ValidateSession(ctx, f.h.user.ID, f.login.SessionID); err != nil {
			return err
		}
		member, err := repository.NewSQLiteServerRepo(f.h.db.Conn).IsMember(ctx, "srv", f.h.user.ID)
		if err != nil {
			return err
		}
		if !member {
			return pkg.ErrForbidden
		}
		channel, err := repository.NewSQLiteChannelRepo(f.h.db.Conn).GetByID(ctx, "ch")
		if err != nil {
			return err
		}
		if channel.Type != models.ChannelTypeVoice || channel.ServerID != "srv" || !f.permission.Load() {
			return pkg.ErrForbidden
		}
		voice := f.voice.GetUserVoiceState(f.h.user.ID)
		if voice == nil || voice.ChannelID != "ch" || voice.ServerID != "srv" || !voice.JoinedAt.Equal(f.joined) || voice.ChannelGeneration != generation {
			return pkg.ErrForbidden
		}
		return nil
	})
}

func TestMusicAccessScopeDeniedAfterExtractionNeverConnects(t *testing.T) {
	for _, change := range []string{"leave", "leave-rejoin", "admin-out-and-back", "membership", "permission", "channel-type", "revoked-session", "retired-actor"} {
		t.Run(change, func(t *testing.T) {
			f := newMusicScopeFixture(t, true)
			if change == "admin-out-and-back" {
				voice, _ := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
					return &models.Channel{ID: id, ServerID: "srv", Type: models.ChannelTypeVoice}, nil
				}})
				if err := voice.JoinChannel(f.h.user.ID, "actor", "Actor", "", "ch", false, false); err != nil {
					t.Fatal(err)
				}
				f.voice = voice.(*voiceService)
				f.joined = f.voice.GetUserVoiceState(f.h.user.ID).JoinedAt
			}
			before := f.svc.GetState("ch")
			var connects, states atomic.Int32
			f.svc.connectBotFn = func(context.Context, *botInstance) error { connects.Add(1); return nil }
			f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { states.Add(1) }}
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			f.svc.extractTracksFn = func(_ context.Context, _ string, id, name string) ([]models.MusicTrack, error) {
				close(started)
				<-release
				return []models.MusicTrack{{VideoID: "denied", RequestedByUserID: id, RequestedByName: name}}, nil
			}
			command := guardedCommand(t, f.svc, "play")
			command.URL = "https://youtu.be/0KbRhUtFwkc"
			done := make(chan error, 1)
			go func() { _, err := f.svc.ApplyMusicCommand(f.context(), f.h.user.ID, "ch", command); done <- err }()
			<-started
			want := pkg.ErrForbidden
			switch change {
			case "leave":
				f.voice.mu.Lock()
				delete(f.voice.states, f.h.user.ID)
				f.voice.mu.Unlock()
			case "leave-rejoin":
				f.voice.mu.Lock()
				f.voice.states[f.h.user.ID].JoinedAt = f.joined.Add(time.Second)
				f.voice.mu.Unlock()
			case "admin-out-and-back":
				for _, channel := range []string{"other", "ch"} {
					if err := f.voice.MoveUser(context.Background(), "admin", f.h.user.ID, channel); err != nil {
						t.Fatal(err)
					}
				}
				if !f.voice.GetUserVoiceState(f.h.user.ID).JoinedAt.Equal(f.joined) {
					t.Fatal("admin move reset quota clock")
				}
			case "membership":
				if _, err := f.h.db.Conn.Exec(`DELETE FROM server_members WHERE server_id='srv' AND user_id=?`, f.h.user.ID); err != nil {
					t.Fatal(err)
				}
			case "permission":
				f.permission.Store(false)
			case "channel-type":
				if _, err := f.h.db.Conn.Exec(`UPDATE channels SET type='text' WHERE id='ch'`); err != nil {
					t.Fatal(err)
				}
			case "revoked-session":
				want = pkg.ErrUnauthorized
				if _, err := f.h.db.Conn.Exec(`UPDATE auth_sessions SET revoked_at=? WHERE id=?`, time.Now().Unix(), f.login.SessionID); err != nil {
					t.Fatal(err)
				}
			case "retired-actor":
				want = pkg.ErrUnauthorized
				if err := f.auth.DeleteAccount(context.Background(), f.h.user.ID, f.login.SessionID, "current-password", ""); err != nil {
					t.Fatal(err)
				}
				states.Store(0)
			}
			once.Do(func() { close(release) })
			select {
			case err := <-done:
				if !errors.Is(err, want) {
					t.Fatalf("scope change=%s error=%v", change, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("scope denial deadlocked")
			}
			after := f.svc.GetState("ch")
			if connects.Load() != 0 || f.svc.lookupBot("ch") != nil || states.Load() != 0 || after.Revision != before.Revision || after.SessionID != before.SessionID || len(after.Queue) != len(before.Queue) {
				t.Fatalf("denied extraction created resources/state: connects=%d events=%d", connects.Load(), states.Load())
			}
		})
	}
}

func TestMusicAccessScopeLossDuringConnectAndReadyCleansOnlyAttempt(t *testing.T) {
	for _, stage := range []string{"connecting", "ready"} {
		t.Run(stage, func(t *testing.T) {
			f := newMusicScopeFixture(t, true)
			before := f.svc.GetState("ch")
			var cancels, events atomic.Int32
			unrelated := &botInstance{channelID: "unrelated", serverID: "srv", loopRunning: true, currentTrack: &models.MusicTrack{VideoID: "other-user"}}
			f.svc.mu.Lock()
			f.svc.bots["unrelated"] = unrelated
			f.svc.mu.Unlock()
			f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { events.Add(1) }}
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			f.svc.connectBotFn = func(_ context.Context, bot *botInstance) error {
				bot.mu.Lock()
				bot.cancelFn = func() { cancels.Add(1) }
				bot.mu.Unlock()
				if stage == "connecting" {
					close(started)
					<-release
				}
				return nil
			}
			ctx := f.context()
			if stage == "ready" {
				base := ctx
				ctx = WithMusicAccessCheck(context.Background(), func(ctx context.Context) error {
					if err := RecheckMusicAccess(base); err != nil {
						return err
					}
					bot := f.svc.lookupBot("ch")
					if bot != nil && bot.ready != nil {
						select {
						case <-bot.ready:
							once.Do(func() { close(started) })
							f.permission.Store(false)
							return pkg.ErrForbidden
						default:
						}
					}
					return nil
				})
			}
			command := guardedCommand(t, f.svc, "play")
			command.URL = "https://youtu.be/0KbRhUtFwkc"
			done := make(chan error, 1)
			go func() { _, err := f.svc.ApplyMusicCommand(ctx, f.h.user.ID, "ch", command); done <- err }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("connect/ready seam not reached")
			}
			if stage == "connecting" {
				f.permission.Store(false)
				once.Do(func() { close(release) })
			}
			select {
			case err := <-done:
				if !errors.Is(err, pkg.ErrForbidden) {
					t.Fatalf("scope denial=%v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("connect cleanup deadlocked")
			}
			if f.svc.lookupBot("ch") != nil || cancels.Load() != 1 || events.Load() != 0 || f.svc.lookupBot("unrelated") != unrelated || unrelated.stopping.Load() {
				t.Fatalf("wrong attempt cleanup: cancel=%d events=%d", cancels.Load(), events.Load())
			}
			after := f.svc.GetState("ch")
			if !reflect.DeepEqual(before, after) {
				t.Fatal("failed connect changed paused queue/head")
			}
		})
	}
}

func TestMusicAccessScopeCommitDenialPreservesExistingPublisherAndRetry(t *testing.T) {
	f := newMusicScopeFixture(t, false)
	bot := f.svc.lookupBot("ch")
	before := f.svc.GetState("ch")
	var events, cancels atomic.Int32
	bot.cancelFn = func() { cancels.Add(1) }
	f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { events.Add(1) }}
	base := f.context()
	var denyOnce atomic.Bool
	denyOnce.Store(true)
	ctx := WithMusicAccessCheck(context.Background(), func(ctx context.Context) error {
		if err := RecheckMusicAccess(base); err != nil {
			return err
		}
		bot.mu.Lock()
		tentative := len(bot.queue) > len(before.Queue)
		bot.mu.Unlock()
		if tentative && denyOnce.CompareAndSwap(true, false) {
			return pkg.ErrForbidden
		}
		return nil
	})
	command := guardedCommand(t, f.svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	if _, err := f.svc.ApplyMusicCommand(ctx, f.h.user.ID, "ch", command); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("commit fence=%v", err)
	}
	if f.svc.lookupBot("ch") != bot || bot.stopping.Load() || cancels.Load() != 0 || events.Load() != 0 || !reflect.DeepEqual(before, f.svc.GetState("ch")) {
		t.Fatal("denied request stopped/edited an existing publisher")
	}
	if _, err := f.svc.ApplyMusicCommand(ctx, f.h.user.ID, "ch", command); err != nil {
		t.Fatalf("failed access check cached success/changed revision: %v", err)
	}
	if len(f.svc.GetState("ch").Queue) != len(before.Queue)+1 || events.Load() != 1 {
		t.Fatal("re-authorized same-request retry was not applied exactly once")
	}
	f.permission.Store(false)
	if _, err := f.svc.ApplyMusicCommand(f.context(), f.h.user.ID, "ch", command); err != nil {
		t.Fatalf("historical exact receipt re-ran access/new work: %v", err)
	}
	if events.Load() != 1 || len(f.svc.GetState("ch").Queue) != len(before.Queue)+1 {
		t.Fatal("receipt retry repeated side effects")
	}
}

func TestMusicAccessScopeMissingOrPanickingCheckFailsBeforeWork(t *testing.T) {
	for _, check := range []func(context.Context) error{nil, func(context.Context) error { panic("fixture validator panic") }} {
		f := newMusicScopeFixture(t, true)
		var extracts atomic.Int32
		f.svc.extractTracksFn = func(context.Context, string, string, string) ([]models.MusicTrack, error) {
			extracts.Add(1)
			return nil, nil
		}
		if _, err := f.svc.Enqueue(WithMusicAccessCheck(context.Background(), check), f.h.user.ID, "ch", "https://youtu.be/0KbRhUtFwkc"); err == nil || extracts.Load() != 0 || f.svc.lookupBot("ch") != nil {
			t.Fatal("missing/failed verification reached extraction/connect")
		}
	}
}

func TestMusicAccessScopeLegacyEnqueueAndRestoreUseSameGuard(t *testing.T) {
	for _, restore := range []bool{false, true} {
		t.Run(map[bool]string{false: "enqueue", true: "restore"}[restore], func(t *testing.T) {
			f := newMusicScopeFixture(t, true, false)
			before := f.svc.GetState("ch")
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			var connects atomic.Int32
			f.svc.extractTracksFn = func(_ context.Context, _ string, id, name string) ([]models.MusicTrack, error) {
				close(started)
				<-release
				return []models.MusicTrack{{VideoID: "denied", RequestedByUserID: id, RequestedByName: name}}, nil
			}
			f.svc.connectBotFn = func(context.Context, *botInstance) error {
				connects.Add(1)
				if restore {
					close(started)
					<-release
				}
				return nil
			}
			done := make(chan error, 1)
			go func() {
				if restore {
					done <- f.svc.Restore(f.context(), "ch")
				} else {
					_, err := f.svc.Enqueue(f.context(), f.h.user.ID, "ch", "https://youtu.be/0KbRhUtFwkc")
					done <- err
				}
			}()
			<-started
			f.voice.mu.Lock()
			f.voice.states[f.h.user.ID].JoinedAt = f.joined.Add(time.Second)
			f.voice.mu.Unlock()
			once.Do(func() { close(release) })
			select {
			case err := <-done:
				if !errors.Is(err, pkg.ErrForbidden) {
					t.Fatalf("legacy access denial=%v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("legacy access cleanup deadlocked")
			}
			if f.svc.lookupBot("ch") != nil || !reflect.DeepEqual(before, f.svc.GetState("ch")) || (!restore && connects.Load() != 0) {
				t.Fatal("legacy path bypassed current voice boundary")
			}
		})
	}
}

func TestMusicAccessScopeAbandonPreservesOtherActorsPausedQueueEdits(t *testing.T) {
	f := newMusicScopeFixture(t, true)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	f.svc.connectBotFn = func(context.Context, *botInstance) error { close(started); <-release; return nil }
	command := guardedCommand(t, f.svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	done := make(chan error, 1)
	go func() { _, err := f.svc.ApplyMusicCommand(f.context(), f.h.user.ID, "ch", command); done <- err }()
	<-started
	other := guardedCommand(t, f.svc, "repeat")
	other.Mode = "all"
	if _, err := f.svc.ApplyMusicCommand(WithMusicAccessCheck(context.Background(), func(context.Context) error { return nil }), "other", "ch", other); err != nil {
		t.Fatal(err)
	}
	accepted := f.svc.GetState("ch")
	var states atomic.Int32
	f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { states.Add(1) }}
	f.permission.Store(false)
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("creator denial=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("creator cleanup deadlocked with other actor")
	}
	if f.svc.lookupBot("ch") != nil || states.Load() != 0 || !reflect.DeepEqual(accepted, f.svc.GetState("ch")) {
		t.Fatal("denied creator discarded another actor's accepted paused-queue edit")
	}
	rows, err := f.svc.sessions.List(context.Background())
	if err != nil || len(rows) != 1 || rows[0].RepeatMode != "all" || rows[0].Revision != accepted.Revision {
		t.Fatal("other actor's durable edit was lost", err)
	}
}

func TestMusicAccessScopeDeniedCreatorCannotStopPublisherClaimedByOtherActor(t *testing.T) {
	f := newMusicScopeFixture(t, true)
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var cancellations atomic.Int32
	f.svc.connectBotFn = func(_ context.Context, bot *botInstance) error {
		bot.mu.Lock()
		bot.cancelFn = func() { cancellations.Add(1) }
		bot.mu.Unlock()
		return nil
	}
	f.svc.extractTracksFn = func(_ context.Context, _ string, id, name string) ([]models.MusicTrack, error) {
		video := "denied-owner"
		if id == "other" {
			video = "valid-other"
		}
		return []models.MusicTrack{{VideoID: video, RequestedByUserID: id, RequestedByName: name}}, nil
	}
	base := f.context()
	var parked atomic.Bool
	ctx := WithMusicAccessCheck(context.Background(), func(ctx context.Context) error {
		if err := RecheckMusicAccess(base); err != nil {
			return err
		}
		bot := f.svc.lookupBot("ch")
		if bot != nil && bot.ready != nil {
			select {
			case <-bot.ready:
				if parked.CompareAndSwap(false, true) {
					close(blocked)
					<-release
					return pkg.ErrForbidden
				}
			default:
			}
		}
		return nil
	})
	first := guardedCommand(t, f.svc, "play")
	first.URL = "https://youtu.be/0KbRhUtFwkc"
	done := make(chan error, 1)
	go func() { _, err := f.svc.ApplyMusicCommand(ctx, f.h.user.ID, "ch", first); done <- err }()
	select {
	case <-blocked:
	case <-time.After(5 * time.Second):
		t.Fatal("creator did not reach ready boundary")
	}
	bot := f.svc.lookupBot("ch")
	other := guardedCommand(t, f.svc, "play")
	other.URL = first.URL
	if _, err := f.svc.ApplyMusicCommand(WithMusicAccessCheck(context.Background(), func(context.Context) error { return nil }), "other", "ch", other); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("creator access result=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("creator cleanup blocked other actor")
	}
	if f.svc.lookupBot("ch") != bot || bot.stopping.Load() || cancellations.Load() != 0 {
		t.Fatal("denied creator stopped another actor's accepted publisher")
	}
	state := f.svc.GetState("ch")
	tracks := append([]models.MusicTrack(nil), state.Queue...)
	if state.CurrentTrack != nil {
		tracks = append(tracks, *state.CurrentTrack)
	}
	found := false
	for _, track := range tracks {
		if track.VideoID == "denied-owner" {
			t.Fatal("denied creator queued a track")
		}
		if track.VideoID == "valid-other" {
			found = true
		}
	}
	if !found {
		t.Fatal("other actor's accepted track was lost")
	}
}

func TestMusicAccessScopeCommitDenialQuietlyDiscardsNewPublisher(t *testing.T) {
	f := newMusicScopeFixture(t, true)
	before := f.svc.GetState("ch")
	var events, cancels atomic.Int32
	f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { events.Add(1) }}
	f.svc.connectBotFn = func(_ context.Context, bot *botInstance) error {
		bot.mu.Lock()
		bot.cancelFn = func() { cancels.Add(1) }
		bot.mu.Unlock()
		return nil
	}
	base := f.context()
	ctx := WithMusicAccessCheck(context.Background(), func(ctx context.Context) error {
		if err := RecheckMusicAccess(base); err != nil {
			return err
		}
		if bot := f.svc.lookupBot("ch"); bot != nil {
			bot.mu.Lock()
			tentative := len(bot.queue) > len(before.Queue)
			bot.mu.Unlock()
			if tentative {
				return pkg.ErrForbidden
			}
		}
		return nil
	})
	command := guardedCommand(t, f.svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	if _, err := f.svc.ApplyMusicCommand(ctx, f.h.user.ID, "ch", command); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("commit fence=%v", err)
	}
	if f.svc.lookupBot("ch") != nil || cancels.Load() != 1 || events.Load() != 0 || !reflect.DeepEqual(before, f.svc.GetState("ch")) {
		t.Fatalf("failed fresh publisher was not quietly rolled back: cancels=%d events=%d", cancels.Load(), events.Load())
	}
}
