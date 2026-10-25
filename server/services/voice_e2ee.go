// Package services — voice room E2EE passphrase management.
// SFrame passphrases are stored in-memory only and cleaned up when rooms empty
// out so a later session cannot decrypt recorded traffic (forward secrecy).
package services

import (
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/pkg"
)

func (s *voiceService) getOrCreateRoomPassphraseLocked(roomName string) (string, error) {
	if passphrase, ok := s.roomPassphrases[roomName]; ok {
		s.ensureRoomKeyContextLocked(roomName, passphrase)
		return passphrase, nil
	}

	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", fmt.Errorf("crypto/rand failed: %w", err)
	}
	passphrase := base64.RawURLEncoding.EncodeToString(raw)

	s.roomPassphrases[roomName] = passphrase
	s.ensureRoomKeyContextLocked(roomName, passphrase)
	if s.roomKeyVersions == nil {
		s.roomKeyVersions = make(map[string]uint32)
	}
	s.roomKeyVersions[roomName] = 0
	voiceLogger.Info("created E2EE passphrase for room", "room_name", roomName)
	return passphrase, nil
}

// MusicRoomKey exposes the same room key and rotation index used by human
// LiveKit clients. The music publisher uses it through a narrow read-only
// interface and therefore never disables voice E2EE.
func (s *voiceService) MusicRoomKey(roomName string) (string, uint32, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	passphrase, err := s.getOrCreateRoomPassphraseLocked(roomName)
	if err != nil {
		return "", 0, err
	}
	return passphrase, s.roomKeyVersions[roomName], nil
}

func (s *voiceService) ensureRoomKeyContextLocked(roomName, initialPassphrase string) {
	if s.roomKeyContexts == nil {
		s.roomKeyContexts = make(map[string]string)
	}
	if s.roomKeyContexts[roomName] == "" {
		sum := sha256.Sum256([]byte("hichat-room-context-v1:" + initialPassphrase))
		s.roomKeyContexts[roomName] = base64.RawURLEncoding.EncodeToString(sum[:])
	}
}
func (s *voiceService) roomMediaKey(roomName string) (string, uint32, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	passphrase, err := s.getOrCreateRoomPassphraseLocked(roomName)
	if err != nil {
		return "", 0, "", err
	}
	return passphrase, s.roomKeyVersions[roomName], s.roomKeyContexts[roomName], nil
}

// cleanupRoomPassphraseIfEmpty deletes the passphrase when a room becomes empty (forward secrecy).
// MUST be called under mu.Lock (caller holds lock).
func (s *voiceService) cleanupRoomPassphraseIfEmpty(channelID string) {
	for _, state := range s.states {
		if state.ChannelID == channelID {
			return
		}
	}

	// Room empty — clean up all matching room names (format: "{serverID}:{channelID}")
	suffix := ":" + channelID
	for roomName := range s.roomPassphrases {
		if strings.HasSuffix(roomName, suffix) {
			delete(s.roomPassphrases, roomName)
			delete(s.roomKeyVersions, roomName)
			delete(s.roomKeyContexts, roomName)
			voiceLogger.Info("cleaned up E2EE passphrase for room", "room_name", roomName)
		}
	}
}

// rotateRoomPassphraseForChannel generates a fresh SFrame passphrase for every
// LiveKit room belonging to the given channel and returns the (roomName, new
// passphrase) pairs. Used after a member is kicked, banned, or moved out of
// the channel: the departing user may already hold the old passphrase, so
// remaining members must re-key for within-session forward secrecy.
//
// Caller is responsible for broadcasting OpVoicePassphraseRotated to remaining
// channel members so they apply the new key to their LiveKit room.
//
// Caller MUST hold mu.Lock. Returns an empty map if no rooms exist for the
// channel (no-op).
func (s *voiceService) rotateRoomPassphraseForChannel(channelID string) map[string]string {
	suffix := ":" + channelID
	rotated := make(map[string]string)
	if s.roomKeyVersions == nil {
		s.roomKeyVersions = make(map[string]uint32)
	}

	for roomName := range s.roomPassphrases {
		if !strings.HasSuffix(roomName, suffix) {
			continue
		}

		raw := make([]byte, 32)
		if _, err := cryptorand.Read(raw); err != nil {
			voiceLogger.Warn("passphrase rotation crypto/rand failed", "room_name", roomName, "err", pkg.ErrText(err))
			continue
		}
		newPassphrase := base64.RawURLEncoding.EncodeToString(raw)
		s.ensureRoomKeyContextLocked(roomName, s.roomPassphrases[roomName])
		s.roomPassphrases[roomName] = newPassphrase
		s.roomKeyVersions[roomName]++
		rotated[roomName] = newPassphrase
		voiceLogger.Info("rotated E2EE passphrase for room (within-session forward secrecy)", "room_name", roomName)
	}

	return rotated
}

// rotateOrCleanupPassphrase picks between rotation and full cleanup based on
// whether the channel still has voice members. Use this on involuntary
// removal events (kick / ban / move) — voluntary leave can keep using the
// existing passphrase since the leaver isn't assumed hostile.
//
// Caller MUST hold mu.Lock. Returns the new passphrases that should be
// broadcast to remaining members (one entry per LiveKit room). Returns nil
// when the channel emptied out (no broadcast needed; cleanup already done).
func (s *voiceService) rotateOrCleanupPassphrase(channelID string) map[string]string {
	for _, state := range s.states {
		if state.ChannelID == channelID {
			// At least one member still here — rotate, don't clean.
			return s.rotateRoomPassphraseForChannel(channelID)
		}
	}
	// Empty room — delegate to existing cleanup (deletes the passphrase).
	s.cleanupRoomPassphraseIfEmpty(channelID)
	return nil
}

// remainingChannelMembers returns userIDs of users still in the given voice
// channel. Used to target the OpVoicePassphraseRotated broadcast so the
// just-kicked attacker never receives the new passphrase.
//
// Caller MUST hold mu.Lock.
func (s *voiceService) remainingChannelMembers(channelID string) []string {
	var users []string
	for userID, state := range s.states {
		if state.ChannelID == channelID {
			users = append(users, userID)
		}
	}
	return users
}
