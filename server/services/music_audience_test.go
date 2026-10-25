package services

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type musicAudienceFixtureVoice struct {
	mu         sync.Mutex
	states     map[string]models.VoiceState
	candidates []models.VoiceState
}

func musicAudienceEventState(event ws.Event) *models.MusicBotChannelState {
	data, ok := event.Data.(map[string]any)
	if !ok {
		return nil
	}
	switch state := data["state"].(type) {
	case *models.MusicBotChannelState:
		return state
	case models.MusicBotChannelState:
		return &state
	}
	return nil
}

func TestMusicAudienceFailedCreatorReconcilesOtherActorsPublishedActiveEdit(t *testing.T) {
	f := newMusicScopeFixture(t, true)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	f.svc.connectBotFn = func(_ context.Context, bot *botInstance) error {
		bot.mu.Lock()
		bot.lkRoom = lksdk.NewRoom(nil)
		bot.mu.Unlock()
		close(started)
		<-release
		return nil
	}
	var mu sync.Mutex
	var states []models.MusicBotChannelState
	f.svc.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { t.Error("server-wide reconciliation") }, BroadcastToUsersFn: func(_ []string, event ws.Event) {
		if state := musicAudienceEventState(event); state != nil {
			mu.Lock()
			states = append(states, *state)
			mu.Unlock()
		}
	}}
	command := guardedCommand(t, f.svc, "play")
	command.URL = "https://youtu.be/0KbRhUtFwkc"
	done := make(chan error, 1)
	go func() { _, err := f.svc.ApplyMusicCommand(f.context(), f.h.user.ID, "ch", command); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("connect seam timeout")
	}
	edit := guardedCommand(t, f.svc, "repeat")
	edit.Mode = "all"
	if _, err := f.svc.ApplyMusicCommand(context.Background(), "other", "ch", edit); err != nil {
		t.Fatal(err)
	}
	accepted := f.svc.GetState("ch")
	if !accepted.IsActive {
		t.Fatal("test never published assigned-room active state")
	}
	f.permission.Store(false)
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("denial=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("creator cleanup deadlock")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(states) != 2 || !states[0].IsActive || states[1].IsActive || !states[1].IsPaused || states[1].Revision != accepted.Revision || states[1].SessionID != accepted.SessionID || states[1].RepeatMode != "all" || !reflect.DeepEqual(states[1].Queue, accepted.Queue) {
		t.Fatalf("missing scoped inactive reconciliation: %#v", states)
	}
	if f.svc.lookupBot("ch") != nil {
		t.Fatal("failed publisher remained")
	}
}

func TestMusicAudienceQuietCleanupWaitsForInFlightActiveDelivery(t *testing.T) {
	s := newTestMusicBotService("ch", "srv")
	bot := s.bots["ch"]
	bot.currentTrack = nil
	bot.loopRunning = false
	bot.lkRoom = lksdk.NewRoom(nil)
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.StopAllForChannel("ch") })
	var mu sync.Mutex
	var active []bool
	s.hub = &testutil.MockBroadcaster{BroadcastToUsersFn: func(_ []string, event ws.Event) {
		state := musicAudienceEventState(event)
		if state == nil {
			return
		}
		if state.IsActive {
			close(started)
			<-release
		}
		mu.Lock()
		active = append(active, state.IsActive)
		mu.Unlock()
	}}
	published := make(chan struct{})
	go func() { s.broadcastState(bot); close(published) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("active delivery not reached")
	}
	ctx := WithMusicAccessCheck(context.Background(), func(context.Context) error { return pkg.ErrForbidden })
	markMusicAttemptBot(ctx, bot)
	cleaned := make(chan struct{})
	go func() { s.cleanupMusicAttemptBot(ctx, bot); close(cleaned) }()
	select {
	case <-cleaned:
		t.Fatal("cleanup skipped in-flight active reconciliation")
	case <-time.After(30 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	for _, done := range []<-chan struct{}{published, cleaned} {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("publication ordering deadlocked")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(active, []bool{true, false}) {
		t.Fatalf("active snapshot overtook final snapshot: %v", active)
	}
	s.broadcastState(bot)
	if len(active) != 2 {
		t.Fatal("stopped bot published again")
	}
}

func (v *musicAudienceFixtureVoice) GetChannelParticipants(channel string) []models.VoiceState {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.candidates != nil {
		return append([]models.VoiceState(nil), v.candidates...)
	}
	var result []models.VoiceState
	for _, state := range v.states {
		if state.ChannelID == channel {
			result = append(result, state)
		}
	}
	return result
}
func (v *musicAudienceFixtureVoice) GetUserVoiceState(user string) *models.VoiceState {
	v.mu.Lock()
	defer v.mu.Unlock()
	state, ok := v.states[user]
	if !ok {
		return nil
	}
	return &state
}

type musicAudienceFixtureMembers struct {
	denied map[string]bool
	fail   bool
}

func (m *musicAudienceFixtureMembers) IsMember(_ context.Context, _ string, user string) (bool, error) {
	if m.fail {
		return false, errors.New("fixture membership failure")
	}
	return !m.denied[user], nil
}

type musicAudienceFixturePerms struct {
	denied map[string]bool
	fail   bool
	during func(string)
}

func (p *musicAudienceFixturePerms) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return models.PermAll, nil
}
func (p *musicAudienceFixturePerms) ResolveChannelPermissionsBulk(ctx context.Context, channel string, users []string) (map[string]models.Permission, error) {
	result := map[string]models.Permission{}
	for _, user := range users {
		permission, err := p.ResolveChannelPermissionsFresh(ctx, user, channel)
		if err != nil {
			return nil, err
		}
		result[user] = permission
	}
	return result, nil
}
func (p *musicAudienceFixturePerms) ResolveChannelPermissionsFresh(_ context.Context, user, _ string) (models.Permission, error) {
	if p.during != nil {
		p.during(user)
	}
	if p.fail {
		return 0, errors.New("fixture permission failure")
	}
	if p.denied[user] {
		return 0, nil
	}
	return models.PermAll, nil
}

// Explicit trusted fixtures: production never gets an implicit allow audience.
func configureMusicAudienceFixture(s *musicBotService, channel, server string) {
	s.audience = MusicAudienceDependencies{Voice: &musicAudienceFixtureVoice{states: map[string]models.VoiceState{"listener": {UserID: "listener", ChannelID: channel, ServerID: server, JoinedAt: time.Unix(1, 0), ChannelGeneration: 1}}}, Members: &musicAudienceFixtureMembers{}}
	s.perms = &musicAudienceFixturePerms{}
	if s.channels == nil {
		s.channels = &stubChannelGetter{channel: &models.Channel{ID: channel, ServerID: server, Type: models.ChannelTypeVoice}}
	}
}

func TestMusicAudienceStateAndErrorsOnlyReachCurrentPermittedParticipants(t *testing.T) {
	for _, denied := range []string{"none", "zero-joined", "zero-generation", "left", "rejoined", "moved-out-back", "leave-during-permission-read", "view-revoked", "membership-revoked", "wrong-server", "wrong-channel", "permission-error", "membership-error", "missing-dependencies", "missing-fresh-resolver", "channel-moved", "text-channel"} {
		t.Run(denied, func(t *testing.T) {
			s := newTestMusicBotService("ch", "srv")
			v := s.audience.Voice.(*musicAudienceFixtureVoice)
			allowed := *v.GetUserVoiceState("listener")
			bad := allowed
			bad.UserID = "restricted"
			v.states[bad.UserID] = bad
			v.candidates = []models.VoiceState{allowed, bad, bad}
			members := s.audience.Members.(*musicAudienceFixtureMembers)
			perms := s.perms.(*musicAudienceFixturePerms)
			switch denied {
			case "zero-joined":
				v.candidates[1].JoinedAt = time.Time{}
				v.candidates[2].JoinedAt = time.Time{}
			case "zero-generation":
				v.candidates[1].ChannelGeneration = 0
				v.candidates[2].ChannelGeneration = 0
			case "left":
				delete(v.states, "restricted")
			case "rejoined":
				bad.JoinedAt = bad.JoinedAt.Add(time.Second)
				v.states[bad.UserID] = bad
			case "moved-out-back":
				bad.ChannelGeneration += 2
				v.states[bad.UserID] = bad
			case "leave-during-permission-read":
				perms.during = func(user string) {
					if user == "restricted" {
						v.mu.Lock()
						delete(v.states, user)
						v.mu.Unlock()
					}
				}
			case "view-revoked":
				perms.denied = map[string]bool{"restricted": true}
			case "membership-revoked":
				members.denied = map[string]bool{"restricted": true}
			case "wrong-server":
				bad.ServerID = "other"
				v.states[bad.UserID] = bad
			case "wrong-channel":
				bad.ChannelID = "other"
				v.states[bad.UserID] = bad
			case "permission-error":
				perms.fail = true
			case "membership-error":
				members.fail = true
			case "missing-dependencies":
				s.audience = MusicAudienceDependencies{}
			case "missing-fresh-resolver":
				s.perms = &testutil.MockChannelPermResolver{}
			case "channel-moved":
				s.channels = &stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "other", Type: models.ChannelTypeVoice}}
			case "text-channel":
				s.channels = &stubChannelGetter{channel: &models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeText}}
			}
			var delivered [][]string
			var events []ws.Event
			s.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { t.Error("server-wide music delivery") }, BroadcastToUsersFn: func(ids []string, event ws.Event) {
				delivered = append(delivered, append([]string(nil), ids...))
				events = append(events, event)
			}}
			bot := s.bots["ch"]
			s.broadcastState(bot)
			s.broadcastPlaybackError(bot, &models.MusicTrack{Title: "private title"}, musicBotErrorReason("test"), 1, false)
			drop := denied == "permission-error" || denied == "membership-error" || denied == "missing-dependencies" || denied == "missing-fresh-resolver" || denied == "channel-moved" || denied == "text-channel"
			if drop {
				if len(events) != 0 {
					t.Fatal("failed closed audience leaked event")
				}
				return
			}
			expected := [][]string{{"listener"}, {"listener"}}
			expectedOps := []string{"music_bot_state", "music_bot_error"}
			if denied == "none" {
				expected = [][]string{{"listener"}, {"restricted"}, {"listener"}, {"restricted"}}
				expectedOps = []string{"music_bot_state", "music_bot_state", "music_bot_error", "music_bot_error"}
			}
			if !reflect.DeepEqual(delivered, expected) {
				t.Fatalf("wrong audience: %#v", delivered)
			}
			for i, event := range events {
				if event.ServerID != "srv" || event.Op != expectedOps[i] {
					t.Fatal("wrong event scope/payload")
				}
			}

		})
	}
}

func TestMusicAudienceRechecksEarlyCandidateAfterLaterLookupRevokesAccess(t *testing.T) {
	for _, revoke := range []string{"membership", "view"} {
		t.Run(revoke, func(t *testing.T) {
			s := newTestMusicBotService("ch", "srv")
			voice := s.audience.Voice.(*musicAudienceFixtureVoice)
			first := *voice.GetUserVoiceState("listener")
			later := first
			later.UserID = "later"
			voice.states[later.UserID] = later
			voice.candidates = []models.VoiceState{first, later}
			members := s.audience.Members.(*musicAudienceFixtureMembers)
			members.denied = map[string]bool{}
			perms := s.perms.(*musicAudienceFixturePerms)
			perms.denied = map[string]bool{}
			perms.during = func(user string) {
				if user == "later" {
					if revoke == "membership" {
						members.denied["listener"] = true
					} else {
						perms.denied["listener"] = true
					}
				}
			}
			var recipients []string
			s.hub = &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { t.Error("broad fallback") }, BroadcastToUsersFn: func(ids []string, _ ws.Event) { recipients = append(recipients, ids...) }}
			s.broadcastState(s.bots["ch"])
			s.broadcastPlaybackError(s.bots["ch"], &models.MusicTrack{Title: "private"}, musicBotErrorReason("test"), 1, false)
			if !reflect.DeepEqual(recipients, []string{"later", "later"}) {
				t.Fatalf("retained revoked early candidate: %v", recipients)
			}
		})
	}
}
