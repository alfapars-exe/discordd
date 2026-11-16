package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type musicSetupLiveKit struct {
	LiveKitInstanceGetter
	instance *models.LiveKitInstance
	calls    int
}

func TestMusicConnectionSetupPreservesSignedRoomGrants(t *testing.T) {
	key := make([]byte, 32)
	apiKey, secret := "fixture-api-key", "fixture-api-secret-with-at-least-32-bytes"
	encrypt := func(value string) string {
		t.Helper()
		result, err := crypto.Encrypt(value, key)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	s := &musicBotService{encryptionKey: key}
	token, err := s.musicBotRoomToken(&botInstance{channelID: "voice", roomName: "server:voice"},
		&models.LiveKitInstance{APIKey: encrypt(apiKey), APISecret: encrypt(secret)})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatal(err)
	}
	identity, grants, err := verifier.Verify(secret)
	if err != nil || identity == nil || identity.Subject != models.MusicBotUserID+":voice" || grants == nil || grants.Video == nil {
		t.Fatalf("signed identity/grants invalid: %v %v", identity, err)
	}
	v := grants.Video
	if !v.RoomJoin || v.Room != "server:voice" || v.CanPublish == nil || !*v.CanPublish ||
		v.CanSubscribe == nil || !*v.CanSubscribe || v.CanPublishData == nil || *v.CanPublishData {
		t.Fatalf("unexpected bot room grant: %+v", v)
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Issuer  string `json:"iss"`
		Name    string `json:"name"`
		Issued  int64  `json:"iat"`
		Expires int64  `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Issuer != apiKey || claims.Name != "MusicBot" || claims.Expires-claims.Issued != 24*60*60 {
		t.Fatalf("unexpected signed token claims: %+v", claims)
	}
}

func TestMusicConnectionSetupEncryptorUsesRoomOpusKey(t *testing.T) {
	source := &mutableMusicRoomKey{passphrase: "fixture-shared-room-key", index: 3}
	s := &musicBotService{roomKeys: source}
	encryptor, err := s.prepareMusicFrameEncryptor("server:voice")
	if err != nil {
		t.Fatal(err)
	}
	decryptor, err := lksdk.NewFrameDecryptor(&musicRoomKeyProvider{source: source, roomName: "server:voice"}, lksdk.CodecOpus, nil)
	if err != nil {
		t.Fatal(err)
	}
	frame := []byte{0xf8, 0xff, 0xfe}
	ciphertext, err := encryptor.EncryptFrame(frame)
	if err != nil || bytes.Equal(ciphertext, frame) {
		t.Fatalf("Opus frame not encrypted: %v", err)
	}
	plaintext, err := decryptor.DecryptFrame(ciphertext)
	if err != nil || !bytes.Equal(plaintext, frame) {
		t.Fatalf("room-key decrypt did not recover Opus frame: %v", err)
	}
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
