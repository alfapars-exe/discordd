package services

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"sync"
	"testing"
	"time"
)

func TestVoiceShutdownFinalizesActiveSessionsOnce(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 4)}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
	s := svc.(*voiceService)
	owner, ok := any(s).(interface{ ShutdownVoiceSessions() })
	if !ok {
		t.Fatal("active voice sessions have no shutdown finalizer")
	}
	joined := time.Now().Add(-time.Minute)
	s.states["a"] = &models.VoiceState{UserID: "a", ChannelID: "ch1", ServerID: "srv1", UsageSessionID: "session-a", LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: joined}
	s.states["b"] = &models.VoiceState{UserID: "b", ChannelID: "ch1", ServerID: "srv1", UsageSessionID: "session-b", LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: joined}
	s.states["c"] = &models.VoiceState{UserID: "c", ChannelID: "ch2", ServerID: "srv1", UsageSessionID: "session-c", JoinedAt: joined}
	music := make(chan string, 4)
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(channel string) { music <- channel }}
	var callers sync.WaitGroup
	for i := 0; i < 16; i++ {
		callers.Add(1)
		go func() { defer callers.Done(); owner.ShutdownVoiceSessions() }()
	}
	callers.Wait()
	if len(s.GetAllVoiceStates()) != 0 {
		t.Fatal("shutdown retained active voice state")
	}
	if len(getter.recorded) != 2 {
		t.Fatalf("final credits=%d want2", len(getter.recorded))
	}
	ids := map[string]bool{<-getter.recorded: true, <-getter.recorded: true}
	if !ids["session-a"] || !ids["session-b"] {
		t.Fatal("final credit lost session identity")
	}
	if len(music) != 2 {
		t.Fatalf("music stops=%d want2", len(music))
	}
	channels := map[string]bool{<-music: true, <-music: true}
	if !channels["ch1"] || !channels["ch2"] {
		t.Fatal("shutdown missed music channel")
	}
	owner.ShutdownVoiceSessions()
	if len(getter.recorded) != 0 || len(music) != 0 {
		t.Fatal("repeated shutdown repeated cleanup")
	}
}

func TestVoiceShutdownBoundsAndJoinsMediaWorkers(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 8)}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
	s := svc.(*voiceService)
	for i := 0; i < 8; i++ {
		id := fmt.Sprint(i)
		s.states[id] = &models.VoiceState{UserID: id, ChannelID: "channel-" + id, ServerID: "server", UsageSessionID: "credit-" + id, LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	}
	entered, release, done := make(chan string, 8), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); <-done })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(channel string) { entered <- channel; <-release }}
	go func() { s.ShutdownVoiceSessions(); close(done) }()
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("four media workers did not start")
		}
	}
	if len(getter.recorded) != 8 {
		t.Fatal("media workers started before all credits")
	}
	select {
	case <-entered:
		t.Fatal("fifth media worker started before release")
	case <-time.After(20 * time.Millisecond):
	}
	select {
	case <-done:
		t.Fatal("shutdown did not join media workers")
	default:
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("media workers did not finish")
	}
	if len(entered) != 4 || len(s.GetAllVoiceStates()) != 0 {
		t.Fatal("remaining media cleanup incomplete")
	}
}

func TestVoiceShutdownSnapshotsAfterAcceptedJoinFinishes(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 2)}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
	s := svc.(*voiceService)
	finish, admitted := s.operations.begin()
	if !admitted {
		t.Fatal("initial join operation rejected")
	}
	done := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(finish); s.ShutdownVoiceSessions(); <-done })
	go func() { s.ShutdownVoiceSessions(); close(done) }()
	waitVoiceUsageAdmissionClosed(t, &s.operations)
	select {
	case <-done:
		t.Fatal("finalizer escaped accepted join")
	default:
	}
	// An already admitted join may publish its state after admission closes.
	s.mu.Lock()
	s.states["accepted"] = &models.VoiceState{UserID: "accepted", ChannelID: "channel", ServerID: "server", UsageSessionID: "accepted-session", LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	s.mu.Unlock()
	release.Do(finish)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("finalizer did not join accepted operation")
	}
	select {
	case id := <-getter.recorded:
		if id != "accepted-session" {
			t.Fatal("finalizer lost accepted session identity")
		}
	default:
		t.Fatal("snapshot missed accepted join")
	}
	if len(s.GetAllVoiceStates()) != 0 {
		t.Fatal("finalizer left accepted session active")
	}
}

func TestVoiceShutdownForgetsOrphanRoomMetadata(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	s.roomPassphrases = map[string]string{"orphan-room": "fixture-key"}
	s.roomKeyContexts = map[string]string{"orphan-room": "fixture-context"}
	s.roomKeyVersions = map[string]uint32{"orphan-room": 4}
	s.screenShareViewers = map[string]map[string]bool{"missing-streamer": {"missing-viewer": true}}
	s.forceMoveGrants = map[string]forceMoveGrant{"missing-user": {channelID: "gone"}}
	s.offlineSince = map[string]time.Time{"missing-user": time.Now()}
	revision := s.voiceRevision
	s.ShutdownVoiceSessions()
	if len(s.roomPassphrases)+len(s.roomKeyContexts)+len(s.roomKeyVersions)+len(s.screenShareViewers)+len(s.forceMoveGrants)+len(s.offlineSince) != 0 {
		t.Fatal("terminal shutdown retained orphan voice metadata")
	}
	if s.voiceRevision <= revision {
		t.Fatal("orphan viewer removal did not advance snapshot revision")
	}
}

func TestVoiceShutdownRejectsLateRoomKeyCreation(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	s.ShutdownVoiceSessions()
	if _, _, err := s.MusicRoomKey("late-room"); !errors.Is(err, context.Canceled) {
		t.Fatalf("terminal music key request was accepted: %v", err)
	}
	if _, _, _, err := s.roomMediaKey("late-room"); !errors.Is(err, context.Canceled) {
		t.Fatalf("terminal media key request was accepted: %v", err)
	}
	if len(s.roomPassphrases)+len(s.roomKeyContexts)+len(s.roomKeyVersions) != 0 {
		t.Fatal("late request recreated terminal key metadata")
	}
}

func TestVoiceShutdownContinuesAfterMusicPanic(t *testing.T) {
	lookups := make(chan string, 16)
	getter := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
		lookups <- "lookup"
		return nil, errors.New("fixture has no media")
	}}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter)
	s := svc.(*voiceService)
	for i := 0; i < 8; i++ {
		id := fmt.Sprint(i)
		s.states[id] = &models.VoiceState{UserID: id, ChannelID: "channel-" + id, ServerID: "server"}
	}
	music := make(chan string, 8)
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(channel string) { music <- channel; panic("shutdown fixture") }}
	done := make(chan struct{})
	go func() { s.ShutdownVoiceSessions(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("panicking music hooks stranded shutdown queue")
	}
	if len(music) != 8 || len(lookups) != 16 {
		t.Fatalf("panic skipped cleanup: music=%d identity_lookups=%d", len(music), len(lookups))
	}
}

func TestVoiceShutdownContinuesAfterCreditPanic(t *testing.T) {
	lookups := make(chan string, 16)
	getter := &panickingChannelCleanupGetter{credits: make(chan string, 8), panicCredit: true}
	getter.GetByServerIDFn = func(context.Context, string) (*models.LiveKitInstance, error) {
		lookups <- "lookup"
		return nil, errors.New("fixture has no media")
	}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
	s := svc.(*voiceService)
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		s.states[id] = &models.VoiceState{UserID: id, ChannelID: "channel-" + id, ServerID: "server", UsageSessionID: id, LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	}
	s.ShutdownVoiceSessions()
	if len(getter.credits) != 8 || len(lookups) != 16 || len(s.GetAllVoiceStates()) != 0 {
		t.Fatalf("credit panic aborted finalization: credits=%d identities=%d", len(getter.credits), len(lookups))
	}
}
