package services

import (
	"crypto/sha256"
	"fmt"
	"sync"

	e2eetypes "github.com/livekit/server-sdk-go/v2/e2ee/types"
	"golang.org/x/crypto/pbkdf2"
)

// MusicRoomKeySource supplies the server-managed SFrame key already issued to
// human participants. It is intentionally read-only and room-scoped.
type MusicRoomKeySource interface {
	MusicRoomKey(roomName string) (passphrase string, keyIndex uint32, err error)
}

// musicRoomKeyProvider implements LiveKit's frame-encryption KeyProvider and
// follows key rotations through the voice service's monotonic key index.
type musicRoomKeyProvider struct {
	source   MusicRoomKeySource
	roomName string

	mu             sync.RWMutex
	lastIndex      uint32
	lastEpoch      uint32
	lastPassphrase string
	initialized    bool
}

func (p *musicRoomKeyProvider) CurrentKeyIndex() uint32 {
	passphrase, epoch, err := p.source.MusicRoomKey(p.roomName)
	p.mu.Lock()
	defer p.mu.Unlock()
	if err == nil {
		if p.initialized && epoch == p.lastEpoch && passphrase == p.lastPassphrase {
			return p.lastIndex
		}
		candidate := epoch
		// The header carries only the low byte. A new key at the same epoch/slot
		// still changes the internal encryptor cache token by one full slot cycle.
		if p.initialized && candidate == p.lastIndex && (epoch != p.lastEpoch || passphrase != p.lastPassphrase) {
			candidate += 256
		}
		p.lastIndex, p.lastEpoch, p.lastPassphrase, p.initialized = candidate, epoch, passphrase, true
	}
	return p.lastIndex
}

func (p *musicRoomKeyProvider) GetKey(index uint32) ([]byte, error) {
	passphrase, current, err := p.source.MusicRoomKey(p.roomName)
	if err != nil {
		return nil, fmt.Errorf("music room key: %w", err)
	}
	// FrameEncryptor retains the full epoch to notice even 256 missed rotations,
	// while SFrame headers and FrameDecryptor use the explicit 8-bit slot.
	p.mu.RLock()
	cacheToken := p.initialized && index == p.lastIndex && current == p.lastEpoch && passphrase == p.lastPassphrase
	p.mu.RUnlock()
	if !cacheToken && index != current && (index > 255 || index != current%256) {
		return nil, fmt.Errorf("music room key index %d is stale (current %d)", index, current)
	}
	return pbkdf2.Key([]byte(passphrase), []byte(e2eetypes.SDKSalt), e2eetypes.PBKDFIterations, e2eetypes.KeySizeBytes, sha256.New), nil
}
