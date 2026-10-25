package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestVoiceChannelGenerationMovesWithoutResettingQuota(t *testing.T) {
	svc, _ := newTestVoiceService()
	if err := svc.JoinChannel("actor", "actor", "Actor", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	concrete := svc.(*voiceService)
	concrete.mu.Lock()
	concrete.states["actor"].LiveKitInstanceID = "quota-instance"
	concrete.states["actor"].LiveKitIsCloud = true
	concrete.mu.Unlock()
	before := svc.GetUserVoiceState("actor")
	for i, channel := range []string{"ch2", "ch1"} {
		if err := svc.MoveUser(context.Background(), "admin", "actor", channel); err != nil {
			t.Fatal(err)
		}
		after := svc.GetUserVoiceState("actor")
		if after.ChannelGeneration != before.ChannelGeneration+uint64(i+1) || !after.JoinedAt.Equal(before.JoinedAt) || after.LiveKitInstanceID != before.LiveKitInstanceID || after.LiveKitIsCloud != before.LiveKitIsCloud {
			t.Fatal("admin move lost channel incarnation or changed quota attribution")
		}
	}
	moved := svc.GetUserVoiceState("actor")
	if err := svc.JoinChannel("actor", "actor", "Refreshed", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	muted := true
	if err := svc.UpdateState("actor", &muted, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.JoinChannel("other", "other", "Other", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	after := svc.GetUserVoiceState("actor")
	if after.ChannelGeneration != moved.ChannelGeneration || !after.JoinedAt.Equal(before.JoinedAt) || after.LiveKitInstanceID != before.LiveKitInstanceID || !after.LiveKitIsCloud {
		t.Fatal("reconnect, mute or unrelated join changed incarnation/quota")
	}
	data, err := json.Marshal(after)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(data)), "generation") {
		t.Fatal("internal generation leaked onto wire")
	}
	if err := svc.MoveUser(context.Background(), "admin", "actor", "ch1"); err == nil {
		t.Fatal("same-channel move unexpectedly accepted")
	}
	if svc.GetUserVoiceState("actor").ChannelGeneration != moved.ChannelGeneration {
		t.Fatal("no-op admin move changed incarnation")
	}
	if err := svc.JoinChannel("actor", "actor", "Actor", "", "ch2", false, false); err != nil {
		t.Fatal(err)
	}
	if svc.GetUserVoiceState("actor").ChannelGeneration != moved.ChannelGeneration+1 {
		t.Fatal("voluntary channel move did not advance incarnation")
	}
}
