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

func TestMusicRoomKeyProviderWrapAndRecreatedRoom(t *testing.T) {
	source := &mutableMusicRoomKey{passphrase: "hichat-cross-sdk-v1"}
	provider := &musicRoomKeyProvider{source: source, roomName: "srv:voice"}
	if provider.CurrentKeyIndex() != 0 {
		t.Fatal("initial epoch is not zero")
	}
	first, err := provider.GetKey(0)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", first) != "e12cedbef126327d289b0359b8839926" {
		t.Fatal("browser/Go derivation mismatch")
	}
	for _, epoch := range []uint32{256, 512} {
		source.mu.Lock()
		source.index = epoch
		source.passphrase = fmt.Sprintf("epoch-%d", epoch)
		source.mu.Unlock()
		if got := provider.CurrentKeyIndex(); got != epoch {
			t.Fatalf("missed rotations suppressed epoch %d: %d", epoch, got)
		}
		full, err := provider.GetKey(epoch)
		if err != nil {
			t.Fatal(err)
		}
		wire, err := provider.GetKey(epoch % 256)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(full, wire) || bytes.Equal(first, wire) {
			t.Fatal("wrapped slot did not use current material")
		}
	}
	source.mu.Lock()
	source.index = 0
	source.passphrase = "recreated-room"
	source.mu.Unlock()
	recreated := provider.CurrentKeyIndex()
	key, err := provider.GetKey(recreated)
	if err != nil {
		t.Fatal(err)
	}
	source.mu.Lock()
	source.passphrase = "second-recreated-room"
	source.mu.Unlock()
	replacement := provider.CurrentKeyIndex()
	if replacement == recreated || replacement%256 != 0 {
		t.Fatal("same-epoch replacement reused encryptor cache")
	}
	newer, err := provider.GetKey(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(key, newer) {
		t.Fatal("replacement retained stale material")
	}
	if provider.CurrentKeyIndex() != replacement {
		t.Fatal("unchanged key cache token is unstable")
	}
}
