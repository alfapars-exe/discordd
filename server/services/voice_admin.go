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
// Requires PermMuteMembers / PermDeafenMembers on the target's channel. A
// mute transition also re-authorizes the target's live LiveKit publish
// grant (applyServerMuteToLiveKit, voice_lifecycle.go) — this is
// enforcement, not just the WS badge/broadcast; deafen has no LiveKit-side
// effect (it's a local listening preference, not something a moderator can
// enforce server-side).
//
// Review HIGH-1 fix — unmute is grant-restore-BEFORE-broadcast, mute stays
// broadcast-then-async-grant: the client's useMicSync reacts to the
// isServerMuted WS flip by immediately calling setMicrophoneEnabled(true);
// it has no listener for LiveKit's own permission-change event (see
// applyServerMuteToLiveKit's doc comment), so if the broadcast reaches the
// client before LiveKit's CanPublish grant is actually restored,
// livekit-client throws a local 403 that useMicSync only console.errors —
// the UI shows "unmuted" but the user cannot publish until manually
// re-toggling their mic. Restoring the grant SYNCHRONOUSLY, before
// unlocking further work and broadcasting, closes that race. The mute leg
// intentionally keeps the original broadcast-first / dispatch-async shape:
// a moderator's mute badge appearing a few hundred ms before LiveKit
// actually silences the target is judged strictly less harmful than
// unfairly leaving a legitimately-unmuted user unable to speak, and it
// avoids adding LiveKit round-trip latency to every mute action.
func (s *voiceService) AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error {
	s.mu.Lock()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, adminUserID, state.ChannelID)
	if err != nil {
		s.mu.Unlock()
		s.logError(models.LogCategoryVoice, &adminUserID, "AdminUpdateState: permission resolve failed", map[string]string{
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": err.Error(),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}

	if isServerMuted != nil && !effectivePerms.Has(models.PermMuteMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: mute members permission required", pkg.ErrForbidden)
	}
	if isServerDeafened != nil && !effectivePerms.Has(models.PermDeafenMembers) {
		s.mu.Unlock()
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

	// Snapshot everything the broadcast/audit/LiveKit-dispatch code below
	// needs, so it can all run AFTER unlocking — this function no longer
	// holds s.mu via defer (HIGH-1 fix: the unmute leg needs to run a
	// synchronous, potentially-slow LiveKit call between the mutation and
	// the broadcast, which must not happen while other voice operations are
	// blocked on s.mu).
	channelID := state.ChannelID
	serverID := state.ServerID
	broadcastData := ws.VoiceStateUpdateBroadcast{
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
	}
	muteChanged := isServerMuted != nil && *isServerMuted != prevMuted
	deafenChanged := isServerDeafened != nil && *isServerDeafened != prevDeafened
	newMuted := state.IsServerMuted
	newDeafened := state.IsServerDeafened
	logMuted := state.IsServerMuted
	logDeafened := state.IsServerDeafened

	s.mu.Unlock()

	// HIGH-1 fix: on an UNMUTE transition, restore the LiveKit publish
	// grant SYNCHRONOUSLY before broadcasting — see this function's doc
	// comment for the race this closes. applyServerMuteToLiveKit re-derives
	// the current mute truth itself (MEDIUM-1), so it converges correctly
	// even if a second, concurrent AdminUpdateState call is racing this one.
	if muteChanged && !newMuted {
		s.applyServerMuteToLiveKit(channelID, targetUserID)
	}

	s.broadcastToServer(serverID, ws.Event{
		Op:   ws.OpVoiceStateUpdate,
		Data: broadcastData,
	})

	// Audit log — one entry per state transition. We split mute and deafen
	// into separate events so the audit channel reads naturally (e.g. "X
	// muted Y" + "X deafened Y" rather than a combined event).
	actor := adminUserID
	target := targetUserID
	if muteChanged {
		eventType := models.AuditEventServerUnmute
		if newMuted {
			eventType = models.AuditEventServerMute
		}
		s.audit(models.AuditLog{
			ServerID:     serverID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    eventType,
		})

		// MUTE leg only — the unmute leg already ran synchronously above,
		// before the broadcast. Dispatched async here: this is the
		// broadcast-first / grant-application-follows shape this feature
		// shipped with originally, kept for mute specifically per this
		// function's doc comment. The goroutine touches no
		// voiceService-mutex-protected state at all (only
		// channelGetter/livekitGetter/network calls via
		// applyServerMuteToLiveKit, plus its own internal currentServerMute
		// call, which takes its own RLock) — channelID/targetUserID are
		// plain string values passed as arguments, not references into
		// `state`. See applyServerMuteToLiveKit (voice_lifecycle.go) for
		// the full design (permission-object preservation,
		// MutePublishedTrack backstop, fail-open mute / retry-then-evict
		// unmute, why deafen/_ss are untouched).
		if newMuted {
			go s.applyServerMuteToLiveKit(channelID, targetUserID)
		}
	}
	if deafenChanged {
		eventType := models.AuditEventServerUndeafen
		if newDeafened {
			eventType = models.AuditEventServerDeafen
		}
		s.audit(models.AuditLog{
			ServerID:     serverID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    eventType,
		})
	}

	voiceLogger.Info("admin updated server voice state",
		"admin_id", adminUserID, "target_id", targetUserID, "muted", logMuted, "deafened", logDeafened)
	return nil
}

// MoveUser moves a user between voice channels on the SAME server (F6
// review LOW: a cross-server target is rejected with pkg.ErrBadRequest —
// see that check's own comment for why).
// Requires PermMoveMembers in both source and target channels (or ConnectVoice for self-move).
// A screen share does not follow the move — it ends in the source channel
// (viewer cleanup + IsStreaming reset, mirroring LeaveChannel) and the
// client must explicitly restart it in the target channel if it wants to
// keep streaming there (see the IsStreaming reset comment below). By
// contrast, IsServerMuted/IsServerDeafened DO survive the move — MoveUser
// mutates the same *models.VoiceState in place rather than replacing it, so
// those fields are never touched here at all, which already gives the same
// "moderation sanction outlives a channel change" behavior JoinChannel's
// cross-channel switch now deliberately replicates (voice_state.go). Safe
// unconditionally now that cross-server moves are rejected outright.
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

	// F6 review LOW decision: reject a cross-server move outright rather
	// than trying to re-attribute quota across two LiveKit instances mid-
	// function. Two options were on the table: (a) re-resolve the target
	// server's LiveKit instance, write it into state, and split-credit the
	// source segment via creditUsage at the boundary; or (b) this — refuse
	// the move. Chose (b): Discord itself has no concept of moving a member
	// between different guilds' voice channels — "move" is inherently a
	// same-server operation there, and this file already leans on Discord
	// parity for the adjacent server-mute/deafen carry-over decision
	// (voice_state.go, A-38). It's also the smaller, more defensible diff,
	// and it closes a second bug for free: before this check, a
	// cross-server move let IsServerMuted/IsServerDeafened cross into the
	// new server unconditionally too (MoveUser mutates state in place with
	// no server gate, unlike JoinChannel's cross-channel branch, which the
	// A-38 review already fixed to gate that carry-over on same-server).
	// Verified this doesn't break the WS call path (ws/hub_callbacks.go,
	// client_voice.go handleVoiceMoveUser): TargetChannelID is forwarded
	// verbatim with no server check of its own, and a MoveUser error is
	// already fire-and-forget there (logged server-side, no client-facing
	// error surfaced) — the exact same shape as every other permission
	// rejection this function already returns.
	if channel.ServerID != state.ServerID {
		s.mu.Unlock()
		return fmt.Errorf("%w: cannot move a user to a voice channel on a different server", pkg.ErrBadRequest)
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

	// A-37: a screen share is a separate LiveKit connection
	// (GenerateScreenShareToken, voice_token.go) tied to sourceChannelID's
	// room — MoveUser only tells the client to switch its MAIN voice
	// connection (OpVoiceForceMove below) and never reconnects or hands off
	// a screen-share sub-participant to targetChannelID. So a stream does
	// not move with the user: IsStreaming must become false here, and the
	// client has to explicitly restart screen sharing in the new channel if
	// it wants to keep streaming there. wasStreaming is snapshotted before
	// the reset so the screen-share cleanup below (mirroring LeaveChannel,
	// voice_state.go) still knows whether one needs closing out.
	wasStreaming := state.IsStreaming
	state.IsStreaming = false

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

	// Screen-share close-out for sourceChannelID — since from the source
	// channel's perspective a move IS a leave. See
	// closeOutScreenShareLocked (voice_screenshare.go).
	s.closeOutScreenShareLocked(targetUserID, sourceChannelID, sourceServerID, wasStreaming)

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

	// F7 review LOW fix: sourceChannelID emptied by this move (sourceRemaining
	// already computed above, under the lock) → kick the music bot (if any),
	// mirroring LeaveChannel's "Channel emptied → kick the music bot"
	// dispatch (same nil-guard, same StopAllForChannel call).
	if len(sourceRemaining) == 0 && s.musicBotHook != nil {
		go s.musicBotHook.StopAllForChannel(sourceChannelID)
	}

	// Remove phantom from old LiveKit room (best-effort). Dual-identity
	// (A-29d): a screen share is a separate LiveKit connection
	// (GenerateScreenShareToken, voice_token.go) that does NOT follow the
	// user to targetChannelID — only the OpVoiceForceMove event above tells
	// the client to switch rooms, and nothing here moves or restarts a
	// screen-share sub-participant. If the moved user was streaming, their
	// "_ss" identity is left orphaned in sourceChannelID exactly like the
	// main identity was before this fix existed, so it gets the same
	// best-effort cleanup.
	go s.removeParticipantAndScreenShareFromLiveKit(sourceChannelID, targetUserID) // #nosec G118 -- deliberately detached: best-effort cleanup that must outlive this call (see removeParticipantFromLiveKit's own doc comment), so it carries its own context.Background()+10s timeout rather than one tied to a caller that may already be gone

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
// A-37 follow-up: this is an independent state-removal path, not a
// delegation to LeaveChannel (voice_state.go) — it does its own
// delete(s.states, ...) and broadcasts, so its screen-share close-out below
// is its own call to closeOutScreenShareLocked (voice_screenshare.go), not
// inherited from anywhere. Same helper call as MoveUser.
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
	// A-37: snapshotted before delete — state's whole entry is about to be
	// removed (unlike MoveUser, which keeps mutating the same state), so
	// this is the last point IsStreaming is readable for this session.
	wasStreaming := state.IsStreaming
	// F4 review MEDIUM fix: same quota-attribution snapshot LeaveChannel
	// takes before its own delete (leaveJoinedAt/leaveInstanceID/
	// leaveIsCloud) — without it, a session an admin ends via force-
	// disconnect was never credited to its cloud LiveKit instance's monthly
	// usage bucket at all (quota under-reported, auto-switch threshold
	// triggers later than it should). See the creditUsage dispatch below,
	// after unlock.
	disconnectJoinedAt := state.JoinedAt
	disconnectInstanceID := state.LiveKitInstanceID
	disconnectIsCloud := state.LiveKitIsCloud
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

	// Screen-share close-out — since a force-disconnect ends the target's
	// whole voice session. See closeOutScreenShareLocked
	// (voice_screenshare.go).
	s.closeOutScreenShareLocked(targetUserID, channelID, serverID, wasStreaming)

	// Forward secrecy for involuntary disconnect: the kicked user might have
	// the SFrame passphrase in memory. Rotating it for remaining members
	// guarantees that traffic published after this moment cannot be decrypted
	// with the leaked passphrase. Empty channels just clean up as before.
	rotatedRooms := s.rotateOrCleanupPassphrase(channelID)
	// F2 review MEDIUM fix: remainingChannelMembers already IS LeaveChannel's
	// channelEmpty scan under a different name — both walk s.states (after
	// the target's delete above, under the same lock) looking for any entry
	// whose ChannelID still equals channelID. len(remaining) == 0 is exactly
	// "channel is now humanless", so this reuses the value already being
	// computed here for the passphrase-rotation broadcast rather than
	// running LeaveChannel's separate boolean-scan a second time — see the
	// dispatch below (after unlock) for the nil-guarded StopAllForChannel
	// call this drives.
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

	// Dual-identity (A-29d): AdminDisconnectUser ends the target's whole
	// voice session (same as LeaveChannel), so a screen share they were
	// running must end with it — a force-disconnected user's "_ss"
	// sub-participant would otherwise keep streaming after their main
	// connection is gone, same MEDIUM finding removeParticipantAndScreenShareFromLiveKit
	// was added for.
	go s.removeParticipantAndScreenShareFromLiveKit(channelID, targetUserID) // #nosec G118 -- deliberately detached: best-effort cleanup that must outlive this call (see removeParticipantFromLiveKit's own doc comment), so it carries its own context.Background()+10s timeout rather than one tied to a caller that may already be gone
	// F4 review MEDIUM fix: credit the force-ended session's duration to
	// its cloud instance's monthly bucket — mirrors LeaveChannel's
	// go s.creditUsage(...) dispatch. Self-hosted, zero-duration, and
	// unset cases are no-ops inside creditUsage itself.
	go s.creditUsage(disconnectInstanceID, disconnectIsCloud, disconnectJoinedAt)

	// F2 review MEDIUM fix: channelID emptied by this disconnect (remaining
	// computed above under the lock, right after delete) → kick the music
	// bot (if any), mirroring LeaveChannel's "Channel emptied → kick the
	// music bot" dispatch (same nil-guard, same StopAllForChannel call).
	if len(remaining) == 0 && s.musicBotHook != nil {
		go s.musicBotHook.StopAllForChannel(channelID)
	}

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
