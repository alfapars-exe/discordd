package services

import (
	"github.com/argeinfina/hichat/models"
	"sync"
	"testing"
	"time"
)

func TestVoiceShutdownFinalizesActiveSessionsOnce(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 4)}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter)
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
