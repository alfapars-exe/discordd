package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
)

type musicSetupLiveKit struct {
	LiveKitInstanceGetter
	instance *models.LiveKitInstance
	calls    int
}

func (g *musicSetupLiveKit) GetByServerID(context.Context, string) (*models.LiveKitInstance, error) {
	g.calls++
	return g.instance, nil
}

func TestMusicConnectionSetupFailsBeforeDial(t *testing.T) {
	key := make([]byte, 32)
	encrypted, err := crypto.Encrypt("fixture-credential", key)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, key, secret, prefix string
		source                    MusicRoomKeySource
		lookups                   int
	}{
		{name: "missing room key", prefix: "music room E2EE key source is unavailable"},
		{name: "room key error", source: &mutableMusicRoomKey{err: errors.New("key unavailable")}, prefix: "prepare music room E2EE key:"},
		{name: "invalid API key", source: &mutableMusicRoomKey{passphrase: "fixture-room"}, key: "invalid", secret: encrypted, prefix: "api key decrypt:", lookups: 1},
		{name: "invalid API secret", source: &mutableMusicRoomKey{passphrase: "fixture-room"}, key: encrypted, secret: "invalid", prefix: "api secret decrypt:", lookups: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			getter := &musicSetupLiveKit{instance: &models.LiveKitInstance{ID: "fixture", APIKey: tc.key, APISecret: tc.secret}}
			s := &musicBotService{roomKeys: tc.source, livekit: getter, encryptionKey: key}
			err := s.connectBotToRoom(context.Background(), &botInstance{channelID: "channel", serverID: "server", roomName: "server:channel"})
			if err == nil || !strings.HasPrefix(err.Error(), tc.prefix) {
				t.Fatalf("setup error = %v, want prefix %q", err, tc.prefix)
			}
			if getter.calls != tc.lookups {
				t.Fatalf("instance lookups = %d, want %d", getter.calls, tc.lookups)
			}
		})
	}
}
