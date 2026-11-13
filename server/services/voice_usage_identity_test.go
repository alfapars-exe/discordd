package services

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
	"strings"
	"testing"
	"time"
)

type recordingUsageGetter struct {
	mockConfigurableLiveKitGetter
	recorded chan string
}

func (g *recordingUsageGetter) RecordVoiceUsage(_ context.Context, id, _ string, _, _, _ int) error {
	g.recorded <- id
	return nil
}

func TestVoiceUsageIdentitySurvivesRejoinAndReachesRecorder(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 4)}
	getter.GetByServerIDFn = func(context.Context, string) (*models.LiveKitInstance, error) {
		return &models.LiveKitInstance{ID: "instance", IsPlatformManaged: true}, nil
	}
	getter.IncrementMonthlyUsageFn = func(context.Context, string, int, int, int) error {
		t.Error("replay-capable getter used unsafe additive fallback")
		return nil
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(getter)
	hub.BroadcastToServerFn = func(string, ws.Event) {}
	hub.BroadcastToUserFn = func(string, ws.Event) {}
	s := svc.(*voiceService)
	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	first := s.states["victim"].UsageSessionID
	s.states["victim"].JoinedAt = time.Now().Add(-time.Minute)
	s.mu.Unlock()
	if first == "" {
		t.Fatal("join omitted stable usage identity")
	}
	if err := svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	state := svc.GetUserVoiceState("victim")
	if state.UsageSessionID != first {
		t.Fatal("same-channel reconnect replaced usage identity")
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), first) || strings.Contains(string(data), "UsageSessionID") {
		t.Fatal("internal usage identity leaked into voice JSON")
	}
	if err = svc.LeaveChannel("victim"); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-getter.recorded:
		if id != first {
			t.Fatal("leave lost usage identity")
		}
	case <-time.After(time.Second):
		t.Fatal("leave never reached replay recorder")
	}
	if err = svc.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	if svc.GetUserVoiceState("victim").UsageSessionID == first {
		t.Fatal("new session reused old identity")
	}
}
