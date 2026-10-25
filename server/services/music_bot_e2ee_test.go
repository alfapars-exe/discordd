package services

import (
	"bytes"
	"fmt"
	"sync"
	"testing"

	lke2ee "github.com/livekit/server-sdk-go/v2/e2ee"
)

type mutableMusicRoomKey struct {
	mu         sync.RWMutex
	passphrase string
	index      uint32
	err        error
}

func (s *mutableMusicRoomKey) MusicRoomKey(string) (string, uint32, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.passphrase, s.index, s.err
}

func TestMusicRoomKeyProviderMatchesLiveKitExternalProvider(t *testing.T) {
	source := &mutableMusicRoomKey{passphrase: "shared-room-secret"}
	provider := &musicRoomKeyProvider{source: source, roomName: "srv:voice"}
	wantProvider := lke2ee.NewExternalKeyProvider()
	if err := wantProvider.SetKeyFromPassphrase(source.passphrase, 0); err != nil {
		t.Fatal(err)
	}

	got, err := provider.GetKey(0)
	if err != nil {
		t.Fatal(err)
	}
	want, err := wantProvider.GetKey(0)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("music publisher key does not match the LiveKit/JS-compatible derivation")
	}
}

func TestMusicRoomKeyProviderFollowsRotationAndRejectsStaleIndex(t *testing.T) {
	source := &mutableMusicRoomKey{passphrase: "first-secret"}
	provider := &musicRoomKeyProvider{source: source, roomName: "srv:voice"}
	first, err := provider.GetKey(0)
	if err != nil {
		t.Fatal(err)
	}

	source.mu.Lock()
	source.passphrase = "rotated-secret"
	source.index = 1
	source.mu.Unlock()

	if got := provider.CurrentKeyIndex(); got != 1 {
		t.Fatalf("current key index = %d, want 1", got)
	}
	rotated, err := provider.GetKey(1)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, rotated) {
		t.Fatal("rotation reused the previous derived key")
	}
	if _, err := provider.GetKey(0); err == nil {
		t.Fatal("stale key index was accepted")
	}

	source.mu.Lock()
	source.err = fmt.Errorf("key source unavailable")
	source.mu.Unlock()
	if _, err := provider.GetKey(1); err == nil {
		t.Fatal("key source failure was ignored")
	}
}
