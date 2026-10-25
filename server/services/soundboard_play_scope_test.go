package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestSoundboardPlayBindsConnectedVoiceServerAndSession(t *testing.T) {
	for _, scenario := range []string{"matching", "wrong-server", "left-during-read", "channel-changed", "rejoined-same-channel"} {
		t.Run(scenario, func(t *testing.T) {
			state := &models.VoiceState{UserID: "actor", ServerID: "voice-server", ChannelID: "voice-channel", JoinedAt: time.Unix(100, 0)}
			voice := &testutil.MockVoiceStateGetter{GetUserVoiceStateFn: func(string) *models.VoiceState {
				if state == nil {
					return nil
				}
				copy := *state
				return &copy
			}, GetChannelParticipantsFn: func(channel string) []models.VoiceState {
				if channel != "voice-channel" {
					t.Fatalf("wrong audience channel=%s", channel)
				}
				return []models.VoiceState{{UserID: "actor"}, {UserID: "listener"}}
			}}
			reads := 0
			repo := &testutil.MockSoundboardRepo{GetByIDFn: func(context.Context, string) (*models.SoundboardSound, error) {
				reads++
				switch scenario {
				case "left-during-read":
					state = nil
				case "channel-changed":
					state.ChannelID = "other"
				case "rejoined-same-channel":
					state.JoinedAt = state.JoinedAt.Add(time.Second)
				}
				return &models.SoundboardSound{ID: "sound", ServerID: "voice-server", FileURL: "/api/uploads/soundboard/clip.wav"}, nil
			}}
			broadcasts := 0
			hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func(ids []string, event ws.Event) {
				broadcasts++
				if len(ids) != 2 || event.Op != ws.OpSoundboardPlay {
					t.Fatalf("audience=%v event=%+v", ids, event)
				}
				payload := event.Data.(models.SoundboardPlayEvent)
				if payload.ServerID != "voice-server" || payload.ChannelID != "voice-channel" {
					t.Fatalf("wrong context=%+v", payload)
				}
			}}
			svc := NewSoundboardService(repo, &testutil.MockUserRepo{}, hub, voice, t.TempDir(), 1024)
			target := "voice-server"
			if scenario == "wrong-server" {
				target = "browsed-server"
			}
			err := svc.Play(context.Background(), target, "sound", "actor", "actor")
			if scenario == "matching" {
				if err != nil || broadcasts != 1 {
					t.Fatalf("matching=%v broadcasts=%d", err, broadcasts)
				}
			} else if !errors.Is(err, pkg.ErrForbidden) || broadcasts != 0 {
				t.Fatalf("stale/cross-server=%v broadcasts=%d", err, broadcasts)
			}
			if scenario == "wrong-server" && reads != 0 {
				t.Fatal("cross-server request reached sound repository")
			}
		})
	}
}
