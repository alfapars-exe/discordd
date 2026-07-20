// Package services — admin voice operations: server mute/deafen, move, disconnect.
// All paths resolve channel permissions (PermMuteMembers / PermDeafenMembers /
// PermMoveMembers) before mutating state.
package services

import (
	"context"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

// AdminUpdateState applies server-level mute/deafen to a user.
// Requires PermMuteMembers / PermDeafenMembers on the target's channel.
func (s *voiceService) AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[targetUserID]
	if !ok {
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, adminUserID, state.ChannelID)
	if err != nil {
		s.logError(models.LogCategoryVoice, &adminUserID, "AdminUpdateState: permission resolve failed", map[string]string{
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": err.Error(),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}

	if isServerMuted != nil && !effectivePerms.Has(models.PermMuteMembers) {
		return fmt.Errorf("%w: mute members permission required", pkg.ErrForbidden)
	}
	if isServerDeafened != nil && !effectivePerms.Has(models.PermDeafenMembers) {
		return fmt.Errorf("%w: deafen members permission required", pkg.ErrForbidden)
	}

	// Snapshot the prior state BEFORE mutation so we can emit "transitioned"
	// audit events (e.g. mute on / mute off) accurately. Mute and deafen
	// are independent toggles — both can flip in one call.
	prevMuted := state.IsServerMuted
	prevDeafened := state.IsServerDeafened

	if isServerMuted != nil {
		state.IsServerMuted = *isServerMuted
	}
	if isServerDeafened != nil {
		state.IsServerDeafened = *isServerDeafened
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

	// Audit log — one entry per state transition. We split mute and deafen
	// into separate events so the audit channel reads naturally (e.g. "X
	// muted Y" + "X deafened Y" rather than a combined event).
	actor := adminUserID
	target := targetUserID
	if isServerMuted != nil && *isServerMuted != prevMuted {
		eventType := models.AuditEventServerUnmute
		if *isServerMuted {
			eventType = models.AuditEventServerMute
		}
		s.audit(models.AuditLog{
			ServerID:     state.ServerID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    eventType,
		})
	}
	if isServerDeafened != nil && *isServerDeafened != prevDeafened {
		eventType := models.AuditEventServerUndeafen
		if *isServerDeafened {
			eventType = models.AuditEventServerDeafen
		}
		s.audit(models.AuditLog{
			ServerID:     state.ServerID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    eventType,
		})
	}

	voiceLogger.Info("admin updated server voice state",
		"admin_id", adminUserID, "target_id", targetUserID, "muted", state.IsServerMuted, "deafened", state.IsServerDeafened)
	return nil
}

// MoveUser moves a user between voice channels.
// Requires PermMoveMembers in both source and target channels (or ConnectVoice for self-move).
func (s *voiceService) MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error {
	channel, err := s.channelGetter.GetByID(ctx, targetChannelID)
	if err != nil {
		return fmt.Errorf("%w: target channel not found", pkg.ErrNotFound)
	}
	if channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: target is not a voice channel", pkg.ErrBadRequest)
	}

	s.mu.Lock()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	sourceChannelID := state.ChannelID

	if sourceChannelID == targetChannelID {
		s.mu.Unlock()
		return fmt.Errorf("%w: user is already in that channel", pkg.ErrBadRequest)
	}

	isSelfMove := moverUserID == targetUserID

	if isSelfMove {
		// Self-move: only need ConnectVoice in target channel (no MoveMembers required)
		targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
		if err != nil {
			s.mu.Unlock()
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			s.mu.Unlock()
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
	} else {
		// Moving another user: require PermMoveMembers in both channels
		sourcePerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, sourceChannelID)
		if err != nil {
			s.mu.Unlock()
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: source channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "source_channel": sourceChannelID, "error": err.Error(),
			})
			return fmt.Errorf("failed to resolve source channel permissions: %w", err)
		}
		if !sourcePerms.Has(models.PermMoveMembers) {
			s.mu.Unlock()
			return fmt.Errorf("%w: move members permission required in source channel", pkg.ErrForbidden)
		}

		targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
		if err != nil {
			s.mu.Unlock()
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: target channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "target_channel": targetChannelID, "error": err.Error(),
			})
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermMoveMembers) {
			s.mu.Unlock()
			return fmt.Errorf("%w: move members permission required in target channel", pkg.ErrForbidden)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			s.mu.Unlock()
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
	}

	sourceServerID := state.ServerID
	targetServerID := channel.ServerID

	state.ChannelID = targetChannelID
	state.ServerID = targetServerID

	// Involuntary move: the moved user knew the source channel's SFrame
	// passphrase. Rotate so the source channel's continued voice traffic
	// can't be decrypted by the moved user from their new vantage point.
	movedSourceRotated := s.rotateOrCleanupPassphrase(sourceChannelID)
	sourceRemaining := s.remainingChannelMembers(sourceChannelID)

	// Broadcast leave(source) + join(target). If both channels are on the same
	// server, one BroadcastToServer covers both events' audiences.
	s.broadcastToServer(sourceServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        sourceChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "leave",
		},
	})
	s.broadcastToServer(targetServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        targetChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "join",
		},
	})

	// Grant one-time permission bypass so the moved user can generate a token
	// for the target channel even without ConnectVoice permission.
	s.forceMoveGrants[targetUserID] = forceMoveGrant{
		channelID: targetChannelID,
		expiresAt: time.Now().Add(30 * time.Second),
	}

	s.mu.Unlock()

	// Tell client to switch LiveKit rooms
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op:   ws.OpVoiceForceMove,
		Data: ws.VoiceForceMoveData{ChannelID: targetChannelID},
	})

	// Tell remaining members of the source channel to re-key (excludes the
	// moved user — they get a fresh passphrase on join via voice/token).
	for _, newPassphrase := range movedSourceRotated {
		s.hub.BroadcastToUsers(sourceRemaining, ws.Event{
			Op: ws.OpVoicePassphraseRotated,
			Data: ws.VoicePassphraseRotatedData{
				ChannelID:  sourceChannelID,
				Passphrase: newPassphrase,
			},
		})
	}

	// Remove phantom from old LiveKit room (best-effort)
	go s.removeParticipantFromLiveKit(sourceChannelID, targetUserID)

	// Audit: voice move (only when an admin moved someone else; self-moves
	// are not moderation events and we don't log them).
	if !isSelfMove {
		mover := moverUserID
		target := targetUserID
		metadata := fmt.Sprintf(`{"from_channel_id":%q,"to_channel_id":%q}`, sourceChannelID, targetChannelID)
		s.audit(models.AuditLog{
			ServerID:     targetServerID,
			ActorUserID:  &mover,
			TargetUserID: &target,
			EventType:    models.AuditEventVoiceMove,
			Metadata:     metadata,
		})
	}

	voiceLogger.Info("user moved another user between voice channels",
		"mover_id", moverUserID, "target_id", targetUserID, "from_channel", sourceChannelID, "to_channel", targetChannelID)
	return nil
}

// AdminDisconnectUser force-disconnects a user from voice.
// Requires PermMoveMembers in the target's current channel (same as Discord).
func (s *voiceService) AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error {
	s.mu.Lock()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, disconnecterUserID, state.ChannelID)
	if err != nil {
		s.mu.Unlock()
		s.logError(models.LogCategoryVoice, &disconnecterUserID, "AdminDisconnectUser: permission resolve failed", map[string]string{
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": err.Error(),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if !effectivePerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required", pkg.ErrForbidden)
	}

	channelID := state.ChannelID
	serverID := state.ServerID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	delete(s.states, targetUserID)

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      targetUserID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	// Forward secrecy for involuntary disconnect: the kicked user might have
	// the SFrame passphrase in memory. Rotating it for remaining members
	// guarantees that traffic published after this moment cannot be decrypted
	// with the leaked passphrase. Empty channels just clean up as before.
	rotatedRooms := s.rotateOrCleanupPassphrase(channelID)
	remaining := s.remainingChannelMembers(channelID)

	s.mu.Unlock()

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpVoiceForceDisconnect,
	})

	// Push the new passphrase to remaining channel members so they re-key
	// their LiveKit session. The just-kicked user is intentionally excluded.
	for _, newPassphrase := range rotatedRooms {
		s.hub.BroadcastToUsers(remaining, ws.Event{
			Op: ws.OpVoicePassphraseRotated,
			Data: ws.VoicePassphraseRotatedData{
				ChannelID:  channelID,
				Passphrase: newPassphrase,
			},
		})
	}

	go s.removeParticipantFromLiveKit(channelID, targetUserID)

	// Audit: voice kick
	disconnecter := disconnecterUserID
	target := targetUserID
	metadata := fmt.Sprintf(`{"channel_id":%q}`, channelID)
	s.audit(models.AuditLog{
		ServerID:     serverID,
		ActorUserID:  &disconnecter,
		TargetUserID: &target,
		EventType:    models.AuditEventVoiceKick,
		Metadata:     metadata,
	})

	voiceLogger.Info("admin disconnected user from voice channel",
		"admin_id", disconnecterUserID, "target_id", targetUserID, "channel_id", channelID)
	return nil
}
