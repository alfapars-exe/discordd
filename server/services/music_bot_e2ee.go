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

	mu        sync.RWMutex
	lastIndex uint32
}

func (p *musicRoomKeyProvider) CurrentKeyIndex() uint32 {
	_, index, err := p.source.MusicRoomKey(p.roomName)
	if err == nil {
		p.mu.Lock()
		p.lastIndex = index
		p.mu.Unlock()
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lastIndex
}

func (p *musicRoomKeyProvider) GetKey(index uint32) ([]byte, error) {
	passphrase, current, err := p.source.MusicRoomKey(p.roomName)
	if err != nil {
		return nil, fmt.Errorf("music room key: %w", err)
	}
	if index != current {
		return nil, fmt.Errorf("music room key index %d is stale (current %d)", index, current)
	}
	return pbkdf2.Key([]byte(passphrase), []byte(e2eetypes.SDKSalt), e2eetypes.PBKDFIterations, e2eetypes.KeySizeBytes, sha256.New), nil
}
