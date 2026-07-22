// Package services — voice channel join/leave/update and state queries.
// Owns the central `states` map lifecycle; all mutations happen here or in
// voice_admin.go. Lock discipline: every state mutation is bracketed by s.mu.
package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

// broadcastToServer publishes a voice-related event to all members of serverID.
// No-op on empty serverID (e.g. channel lookup failed) so malformed state can't
// leak broadcasts to the wrong audience.
func (s *voiceService) broadcastToServer(serverID string, event ws.Event) {
	if serverID == "" {
		return
	}
	s.hub.BroadcastToServer(serverID, event)
}

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error {
	// Resolve channel's parent server before locking — all voice broadcasts are server-scoped.
	ctx := context.Background()
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	serverID := channel.ServerID

	// Resolve LiveKit instance for quota tracking. Failure here is non-fatal —
	// the join still happens, we just won't be able to attribute the session
	// duration to an instance. Logged for visibility.
	var lkInstanceID string
	var lkIsCloud bool
	if lkInst, lkErr := s.livekitGetter.GetByServerID(ctx, serverID); lkErr == nil && lkInst != nil {
		lkInstanceID = lkInst.ID
		lkIsCloud = lkInst.IsPlatformManaged
	} else if lkErr != nil {
		voiceLogger.Error("join: livekit instance lookup failed", "server_id", serverID, "err", pkg.ErrText(lkErr))
	}

	var oldChannelID string
	var oldServerID string
	var oldJoinedAt time.Time
	var oldInstanceID string
	var oldIsCloud bool

	s.mu.Lock()

	// Leave current channel if in one
	if existing, ok := s.states[userID]; ok {
		oldChannelID = existing.ChannelID
		oldServerID = existing.ServerID
		oldJoinedAt = existing.JoinedAt
		oldInstanceID = existing.LiveKitInstanceID
		oldIsCloud = existing.LiveKitIsCloud

		// Same-channel rejoin (WS reconnect) — silently refresh state, no broadcast.
		// This prevents false leave/join sounds for everyone in the channel.
		// Quota fields (JoinedAt / LiveKitInstanceID / LiveKitIsCloud) are
		// preserved so the eventual leave still attributes the full session
		// duration, not just the time since the last reconnect.
		if oldChannelID == channelID {
			existing.Username = username
			existing.DisplayName = displayName
			existing.AvatarURL = avatarURL
			existing.LastActivity = time.Now()
			s.mu.Unlock()
			voiceLogger.Info("same-channel rejoin (no broadcast)", "user_id", userID, "channel_id", channelID)
			return nil
		}

		delete(s.states, userID)

		s.broadcastToServer(oldServerID, ws.Event{
			Op: ws.OpVoiceStateUpdate,
			Data: ws.VoiceStateUpdateBroadcast{
				UserID:           userID,
				ChannelID:        oldChannelID,
				Username:         username,
				DisplayName:      displayName,
				AvatarURL:        avatarURL,
				IsServerMuted:    existing.IsServerMuted,
				IsServerDeafened: existing.IsServerDeafened,
				Action:           "leave",
			},
		})

		s.cleanupRoomPassphraseIfEmpty(oldChannelID)
	}

	now := time.Now()
	s.states[userID] = &models.VoiceState{
		UserID:            userID,
		ChannelID:         channelID,
		ServerID:          serverID,
		Username:          username,
		DisplayName:       displayName,
		AvatarURL:         avatarURL,
		IsMuted:           isMuted,
		IsDeafened:        isDeafened,
		LastActivity:      now,
		JoinedAt:          now,
		LiveKitInstanceID: lkInstanceID,
		LiveKitIsCloud:    lkIsCloud,
	}

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			IsMuted:     isMuted,
			IsDeafened:  isDeafened,
			Action:      "join",
		},
	})

	s.mu.Unlock()

	// Remove phantom participant from old LiveKit room (best-effort, outside lock)
	if oldChannelID != "" && oldChannelID != channelID {
		go s.removeParticipantFromLiveKit(oldChannelID, userID)
		// Cross-channel switch — credit the old session's duration to the
		// instance it ran on. Self-hosted instances are skipped.
		go s.creditUsage(oldInstanceID, oldIsCloud, oldJoinedAt)
	}

	voiceLogger.Info("user joined voice channel", "user_id", userID, "channel_id", channelID)
	return nil
}

// creditUsage writes a completed voice session's duration to its instance's
// monthly bucket. Skips self-hosted (we don't track those) and zero-duration
// or unset cases (e.g. lookup failed at join time). Async-safe — runs in a
// goroutine from the leave/cleanup paths.
func (s *voiceService) creditUsage(instanceID string, isCloud bool, joinedAt time.Time) {
	if !isCloud || instanceID == "" || joinedAt.IsZero() {
		return
	}
	seconds := int(time.Since(joinedAt).Seconds())
	if seconds <= 0 {
		return
	}
	now := time.Now()
	year, month, _ := now.Date()
	if err := s.livekitGetter.IncrementMonthlyUsage(
		context.Background(), instanceID, year, int(month), seconds,
	); err != nil {
		voiceLogger.Error("credit usage failed", "instance_id", instanceID, "seconds", seconds, "err", pkg.ErrText(err))
	}
}

func (s *voiceService) LeaveChannel(userID string) error {
	s.mu.Lock()

	state, ok := s.states[userID]
	if !ok {
		s.mu.Unlock()
		return nil
	}

	channelID := state.ChannelID
	serverID := state.ServerID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	wasStreaming := state.IsStreaming
	// Capture quota fields before delete — used after lock release to credit
	// session duration to the instance it ran on.
	leaveJoinedAt := state.JoinedAt
	leaveInstanceID := state.LiveKitInstanceID
	leaveIsCloud := state.LiveKitIsCloud
	delete(s.states, userID)

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	// Clean up screen share viewer tracking for the leaving user
	if wasStreaming {
		// User was streaming — clear their viewer set and broadcast final update
		delete(s.screenShareViewers, userID)
		s.broadcastToServer(serverID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      channelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		})
	}
	// User was a viewer — remove from all streamer viewer sets
	for streamerID, viewers := range s.screenShareViewers {
		if viewers[userID] {
			delete(viewers, userID)
			viewerCount := len(viewers)
			if viewerCount == 0 {
				delete(s.screenShareViewers, streamerID)
			}
			// Find streamer's channel for broadcast
			if streamerState, ok := s.states[streamerID]; ok {
				s.broadcastToServer(streamerState.ServerID, ws.Event{
					Op: ws.OpScreenShareViewerUpdate,
					Data: ws.ScreenShareViewerUpdateData{
						StreamerUserID: streamerID,
						ChannelID:      streamerState.ChannelID,
						ViewerCount:    viewerCount,
						ViewerUserID:   userID,
						Action:         "leave",
					},
				})
			}
		}
	}

	// Clean up E2EE passphrase if room is empty (forward secrecy)
	s.cleanupRoomPassphraseIfEmpty(channelID)

	// Channel is now humanless if no one else's voice state references it.
	// The music bot isn't tracked in s.states (it joins LiveKit directly),
	// so this count reflects real users only.
	channelEmpty := true
	for _, st := range s.states {
		if st.ChannelID == channelID {
			channelEmpty = false
			break
		}
	}

	s.mu.Unlock()

	// Remove from LiveKit (best-effort, outside lock — involves DB calls)
	go s.removeParticipantFromLiveKit(channelID, userID)
	// Credit the completed session's duration to the cloud instance bucket.
	// Self-hosted, zero-duration, and unset cases are no-ops inside creditUsage.
	go s.creditUsage(leaveInstanceID, leaveIsCloud, leaveJoinedAt)

	// Channel emptied → kick the music bot (if any) so it doesn't keep
	// playing to nobody and burning bandwidth/CPU.
	if channelEmpty && s.musicBotHook != nil {
		go s.musicBotHook.StopAllForChannel(channelID)
	}

	voiceLogger.Info("user left voice channel", "user_id", userID, "channel_id", channelID)
	return nil
}

func (s *voiceService) UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return nil
	}

	wasStreaming := state.IsStreaming

	if maxScreenShares > 0 && isStreaming != nil && *isStreaming {
		count := 0
		for _, st := range s.states {
			if st.ChannelID == state.ChannelID && st.IsStreaming && st.UserID != userID {
				count++
			}
		}
		if count >= maxScreenShares {
			return fmt.Errorf("%w: maximum screen shares reached", pkg.ErrBadRequest)
		}
	}

	if isMuted != nil {
		state.IsMuted = *isMuted
	}
	if isDeafened != nil {
		state.IsDeafened = *isDeafened
	}
	if isStreaming != nil {
		state.IsStreaming = *isStreaming
	}

	s.broadcastToServer(state.ServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        state.ChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "update",
		},
	})

	// Streamer stopped streaming — clean up viewer tracking and broadcast final update
	if wasStreaming && !state.IsStreaming {
		delete(s.screenShareViewers, userID)
		s.broadcastToServer(state.ServerID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      state.ChannelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		})
	}

	return nil
}

// ─── Query Methods ───

func (s *voiceService) GetChannelParticipants(channelID string) []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var participants []models.VoiceState
	for _, state := range s.states {
		if state.ChannelID == channelID {
			participants = append(participants, *state)
		}
	}
	return participants
}

func (s *voiceService) GetUserVoiceState(userID string) *models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if state, ok := s.states[userID]; ok {
		copy := *state
		return &copy
	}
	return nil
}

func (s *voiceService) GetAllVoiceStates() []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	states := make([]models.VoiceState, 0, len(s.states))
	for _, state := range s.states {
		states = append(states, *state)
	}
	return states
}

func (s *voiceService) DisconnectUser(userID string) {
	if err := s.LeaveChannel(userID); err != nil {
		voiceLogger.Error("disconnect cleanup failed", "user_id", userID, "err", pkg.ErrText(err))
	}
}

func (s *voiceService) GetStreamCount(channelID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, state := range s.states {
		if state.ChannelID == channelID && state.IsStreaming {
			count++
		}
	}
	return count
}

func (s *voiceService) GetUserVoiceChannelID(userID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if state, ok := s.states[userID]; ok {
		return state.ChannelID
	}
	return ""
}
