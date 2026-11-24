// Package services — admin voice operations: server mute/deafen, move, disconnect.
// All paths resolve channel permissions (PermMuteMembers / PermDeafenMembers /
// PermMoveMembers) before mutating state.
package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
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
	finishOperation, admitted := s.operations.begin()
	if !admitted {
		return context.Canceled
	}
	defer finishOperation()

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
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": pkg.ErrText(err),
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
	voiceRevision := s.bumpVoiceRevisionLocked()

	s.mu.Unlock()

	// HIGH-1 fix: on an UNMUTE transition, restore the LiveKit publish
	// grant SYNCHRONOUSLY before broadcasting — see this function's doc
	// comment for the race this closes. applyServerMuteToLiveKit re-derives
	// the current mute truth itself (MEDIUM-1), so it converges correctly
	// even if a second, concurrent AdminUpdateState call is racing this one.
	if muteChanged && !newMuted {
		s.applyServerMuteToLiveKit(channelID, targetUserID)
	}

	s.broadcastToServerAtRevision(serverID, ws.Event{
		Op:   ws.OpVoiceStateUpdate,
		Data: broadcastData,
	}, voiceRevision)

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
			s.operations.child(func() { s.applyServerMuteToLiveKit(channelID, targetUserID) })
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
	finishOperation, admitted := s.operations.begin()
	if !admitted {
		return context.Canceled
	}
	defer finishOperation()

	// Everything from here to the write lock is the database phase: each
	// statement is a round trip to the database host. With a snapshot reader
	// the target channel and the moved user's fresh permissions come from one
	// access read, issued together with the mover's own permission reads
	// (startMoveReads); without one the statements run one after another.
	dbStart := time.Now()
	var reads *voiceMoveReads
	var channel *models.Channel
	var err error
	if reader := s.voiceAccess; reader != nil {
		reads = s.startMoveReads(ctx, reader, moverUserID, targetUserID, targetChannelID)
		defer reads.pending.Wait()
		if err = reads.err; err == nil {
			channel = &reads.admission.Channel
		} else if !errors.Is(err, pkg.ErrNotFound) {
			// Only a missing channel is "target channel not found". A read
			// that failed (connection reset, deadline, pool wait) keeps its
			// cause for the caller's log line.
			return fmt.Errorf("load voice move access: %w", err)
		}
	} else {
		channel, err = s.channelGetter.GetByID(ctx, targetChannelID)
	}
	if err != nil {
		return fmt.Errorf("%w: target channel not found", pkg.ErrNotFound)
	}
	if channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: target is not a voice channel", pkg.ErrBadRequest)
	}

	lockStart := time.Now()
	s.mu.RLock()
	readStart := time.Now()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.RUnlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	sourceChannelID := state.ChannelID

	if sourceChannelID == targetChannelID {
		s.mu.RUnlock()
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
		s.mu.RUnlock()
		return fmt.Errorf("%w: cannot move a user to a voice channel on a different server", pkg.ErrBadRequest)
	}

	generation := state.ChannelGeneration
	s.mu.RUnlock()
	readHeld := time.Since(readStart)

	isSelfMove := moverUserID == targetUserID
	needsPlacementGrant := false

	if isSelfMove {
		// Self-move: only need ConnectVoice in target channel (no MoveMembers required)
		var targetPerms models.Permission
		if reads != nil {
			// The access snapshot was read for this same user and channel.
			targetPerms = reads.admission.Permissions
		} else if targetPerms, err = s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID); err != nil {
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
	} else {
		// Moving another user: require PermMoveMembers in both channels
		sourcePerms, err := s.moverPermissions(ctx, reads, moverUserID, sourceChannelID)
		if err != nil {
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: source channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "source_channel": sourceChannelID, "error": pkg.ErrText(err),
			})
			return fmt.Errorf("failed to resolve source channel permissions: %w", err)
		}
		if !sourcePerms.Has(models.PermMoveMembers) {
			return fmt.Errorf("%w: move members permission required in source channel", pkg.ErrForbidden)
		}

		targetPerms, err := s.moverPermissions(ctx, reads, moverUserID, targetChannelID)
		if err != nil {
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: target channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "target_channel": targetChannelID, "error": pkg.ErrText(err),
			})
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermMoveMembers) {
			return fmt.Errorf("%w: move members permission required in target channel", pkg.ErrForbidden)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
		var memberPerms models.Permission
		if reads != nil {
			// Same fresh, uncached read currentVoicePermissions would make.
			memberPerms = reads.admission.Permissions
		} else if memberPerms, err = s.currentVoicePermissions(ctx, targetUserID, targetChannelID); err != nil {
			return fmt.Errorf("resolve moved member permissions: %w", err)
		}
		needsPlacementGrant = !memberPerms.Has(models.PermConnectVoice)

	}

	writeWait := time.Now()
	dbPhase := writeWait.Sub(dbStart)
	s.mu.Lock()
	writeStart := time.Now()
	if current := s.states[targetUserID]; current != state || current.ChannelID != sourceChannelID || current.ChannelGeneration != generation {
		s.mu.Unlock()
		return fmt.Errorf("%w: voice session changed during move", pkg.ErrBadRequest)
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

	state.ChannelGeneration++
	state.ChannelID = targetChannelID
	state.ForceMoved = needsPlacementGrant
	state.ServerID = targetServerID

	// Snapshotted for the embedded credentials minted after unlock
	// (moveCredentials): this placement is what that token is issued for.
	placement := voiceMovePlacement{
		state:       state,
		generation:  state.ChannelGeneration,
		username:    state.Username,
		displayName: state.DisplayName,
		granted:     needsPlacementGrant,
	}

	// Involuntary move: the moved user knew the source channel's SFrame
	// passphrase. Rotate so the source channel's continued voice traffic
	// can't be decrypted by the moved user from their new vantage point.
	movedSourceRotated := s.rotateOrCleanupPassphrase(sourceChannelID)
	sourceRemaining := s.remainingChannelMembers(sourceChannelID)

	// Broadcast leave(source) + join(target). If both channels are on the same
	// server, one BroadcastToServer covers both events' audiences.
	s.broadcastToServerLocked(sourceServerID, ws.Event{
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
	s.broadcastToServerLocked(targetServerID, ws.Event{
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
	delete(s.forceMoveGrants, targetUserID)
	if needsPlacementGrant {
		s.forceMoveGrants[targetUserID] = forceMoveGrant{
			channelID: targetChannelID,
			expiresAt: time.Now().Add(30 * time.Second),
		}
	}

	rotations := make([]ws.VoicePassphraseRotatedData, 0, len(movedSourceRotated))
	for roomName, newPassphrase := range movedSourceRotated {
		rotations = append(rotations, ws.VoicePassphraseRotatedData{
			ChannelID:  sourceChannelID,
			Passphrase: newPassphrase,
			KeyIndex:   s.roomKeyVersions[roomName] % 256,
			KeyEpoch:   uint64(s.roomKeyVersions[roomName]),
			KeyContext: s.roomKeyContexts[roomName],
		})
	}

	s.mu.Unlock()

	voiceLogger.Debug("voice move lock timing", "lock_wait", readStart.Sub(lockStart)+writeStart.Sub(writeWait), "lock_held", readHeld+time.Since(writeStart), "db_phase", dbPhase)

	// Tell remaining members of the source channel to re-key (excludes the
	// moved user — they get a fresh passphrase on join via voice/token).
	// First thing after the unlock, ahead of the credential mint below: that
	// takes s.mu again and may wait behind another holder, and until this
	// goes out the source room keeps encrypting with the key the moved user
	// holds.
	for _, rotation := range rotations {
		s.hub.BroadcastToUsers(sourceRemaining, ws.Event{Op: ws.OpVoicePassphraseRotated, Data: rotation})
	}

	// Tell client to switch LiveKit rooms. The target room's credentials ride
	// along when they can be minted from the access snapshot — the one
	// already read, or one re-read here when that has aged past its bound —
	// saving the moved client its own token request; nil leaves the field off
	// and the client asks over HTTP as before. Never under s.mu: the re-read
	// is a database round trip and token issuance takes the lock itself.
	mintStart := time.Now()
	voice, credentials := s.moveCredentials(ctx, reads, placement, targetUserID)
	mintTime := time.Since(mintStart)
	// The mint can be a database round trip with s.mu free, long enough for
	// another MoveUser to place this same session somewhere else and send its
	// own voice_force_move. The client follows whichever instruction arrives
	// last, so this one — for a channel the session has already been moved out
	// of — must not go out after it. ChannelGeneration is advanced in place
	// only by MoveUser (above): the same state with another generation is
	// exactly "a later move owns this session". A leave, a kick or the user's
	// own voice_join removes or replaces the state instead, and none of those
	// sends an instruction, so this event still goes out then, as it always
	// has.
	s.mu.RLock()
	superseded := s.states[targetUserID] == placement.state && placement.state.ChannelGeneration != placement.generation
	s.mu.RUnlock()
	if !superseded {
		s.hub.BroadcastToUser(targetUserID, ws.Event{
			Op:   ws.OpVoiceForceMove,
			Data: ws.VoiceForceMoveData{ChannelID: targetChannelID, ServerID: targetServerID, Voice: voice},
		})
	}
	// How the credentials were obtained (voiceMoveCredentials* below) and what
	// the mint cost, a re-read included.
	voiceLogger.Debug("voice move credentials", "credentials", credentials, "credentials_mint", mintTime)
	if dbPhase > voiceMoveSlowDBPhase {
		voiceLogger.Info("voice move database phase slow", "db_phase", dbPhase, "credentials_embedded", voice != nil,
			"credentials", credentials, "credentials_mint", mintTime)
	}

	// F7 review LOW fix: sourceChannelID emptied by this move (sourceRemaining
	// already computed above, under the lock) → kick the music bot (if any),
	// mirroring LeaveChannel's "Channel emptied → kick the music bot"
	// dispatch (same nil-guard, same StopAllForChannel call).
	if len(sourceRemaining) == 0 && s.musicBotHook != nil {
		s.operations.child(func() { s.musicBotHook.StopAllForChannel(sourceChannelID) })
	}

	// Remove phantom from old LiveKit room (best-effort). Dual-identity
	// (A-29d): a screen share is a separate LiveKit connection
	// (GenerateScreenShareToken, voice_token.go) that does NOT follow the
	// user to targetChannelID — only the OpVoiceForceMove event above tells
	// the client to switch rooms, and nothing here moves or restarts a
	// screen-share sub-participant. If the moved user was streaming, their
	// "_ss" identity is left orphaned in sourceChannelID exactly like the
	// main identity was before this fix existed, so it gets the same
	// best-effort cleanup. Guarded like every departure: skipped if the user
	// is back in sourceChannelID by the time it runs (see
	// removeDepartedParticipantFromLiveKit, voice_lifecycle.go).
	s.operations.child(func() { s.removeDepartedParticipantFromLiveKit(sourceServerID, sourceChannelID, targetUserID) })

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

// voiceMoveSlowDBPhase is the pre-lock database time above which MoveUser
// reports the move at Info instead of only in its debug timing line. A
// variable only so a test can take wall-clock time out of its fast half.
var voiceMoveSlowDBPhase = 250 * time.Millisecond

// voiceMoveReads is MoveUser's database phase on the snapshot path
// (s.voiceAccess != nil).
type voiceMoveReads struct {
	// One access read for the moved user and the target channel, written by
	// startMoveReads before it returns and never afterwards: a re-read made
	// by moveCredentials lives in that call, not here.
	voiceMoveSnapshot
	err error

	// The mover's own permission reads, started alongside the access read.
	// pending must be waited on before MoveUser returns.
	source, target voiceMovePermRead
	pending        sync.WaitGroup
}

// voiceMoveSnapshot is one answer of the access read for the moved user and
// the target channel: the channel row, membership, timeout, fresh effective
// permissions, and the LiveKit instance with this month's usage. instance is
// nil when the server has no LiveKit instance linked (the move still applies;
// no credentials).
type voiceMoveSnapshot struct {
	admission *models.VoiceAdmission
	instance  *models.LiveKitInstance
	used      int64
	// readAt is when the read answered; moveCredentials does not mint from a
	// snapshot older than voiceMoveCredentialsMaxSnapshotAge.
	readAt time.Time
}

// stale reports whether the snapshot is too old to mint from. One without a
// read time is as old as a snapshot can be.
func (v voiceMoveSnapshot) stale() bool {
	return time.Since(v.readAt) > voiceMoveCredentialsMaxSnapshotAge
}

// voiceMovePermRead is one of the mover's permission reads. channelID is
// empty when the read was never started.
type voiceMovePermRead struct {
	channelID string
	perms     models.Permission
	err       error
}

// startMoveReads issues MoveUser's database reads together and returns once
// the access read has answered. A self-move needs nothing beyond it. For a
// moderator move the source channel is only known from the target's voice
// state, which MoveUser reads authoritatively AFTER its channel checks (and
// re-checks under the write lock) — so the channel peeked here is just what
// the source read is started for; moverPermissions resolves again if the
// authoritative one turns out to differ.
func (s *voiceService) startMoveReads(ctx context.Context, reader repository.VoiceAccessReader, moverUserID, targetUserID, targetChannelID string) *voiceMoveReads {
	reads := &voiceMoveReads{}
	if moverUserID != targetUserID {
		s.mu.RLock()
		if state, ok := s.states[targetUserID]; ok {
			reads.source.channelID = state.ChannelID
			reads.target.channelID = targetChannelID
		}
		s.mu.RUnlock()
		for _, read := range []*voiceMovePermRead{&reads.source, &reads.target} {
			if read.channelID == "" {
				continue
			}
			reads.pending.Add(1)
			logx.Go("voice-move-permissions", func() {
				defer reads.pending.Done()
				read.perms, read.err = s.permResolver.ResolveChannelPermissions(ctx, moverUserID, read.channelID)
			})
		}
	}

	reads.admission, reads.instance, reads.used, reads.err = reader.VoiceTokenAccess(ctx, targetUserID, targetChannelID, time.Now())
	if errors.Is(reads.err, pkg.ErrNotFound) {
		// The token read joins the server's LiveKit instance, so "not found"
		// is also what a channel on a server with no instance linked looks
		// like. MoveUser has never required one; only the channel itself
		// being gone is "target channel not found".
		reads.instance, reads.used = nil, 0
		reads.admission, reads.err = reader.VoiceAdmission(ctx, targetUserID, targetChannelID)
	}
	reads.readAt = time.Now()
	return reads
}

// voiceMoveCredentialsMaxSnapshotAge is how old an access snapshot may be, at
// most, when MoveUser mints credentials from it. Without embedded credentials
// the moved client requests its token only after the move, so GenerateToken's
// read sees a timeout, kick, ban or permission change that was committed
// while the move was still waiting on the mover's permission reads or on the
// lock. A snapshot older than this (about one database round trip) no longer
// stands in for that read, so it is never minted from.
//
// It is not the end of the embedded credentials either: moveCredentials
// repeats the access read once — after the move has been applied and s.mu
// released — and mints from that answer, which is as recent as the read the
// client's own token request would have made. The bound holds for the
// repeated read as well: if that one has aged past it by the time the
// credentials would leave, or the read fails, the event goes out without
// credentials and the client asks over HTTP.
//
// A move whose mover-permission reads were cached mints from the first
// snapshot, well inside the bound and with no further statement. The repeat
// is paid by a move whose reads missed the permission cache (permCacheTTL,
// channel_permission_cache.go) — a moderator's first move in a while: one
// more round trip before voice_force_move, in place of the token request the
// moved client would otherwise make after it. A variable only for tests.
var voiceMoveCredentialsMaxSnapshotAge = 150 * time.Millisecond

// voiceMoveRefreshTimeout bounds the repeated access read on its own. When
// that read is issued the move has already been applied and broadcast, and
// voice_force_move is waiting for nothing else; on MoveUser's ctx alone a
// stalled database would hold the event back for whatever is left of the
// move's budget (seconds). The read only pays off while it is cheaper than
// the token request the moved client makes otherwise — about 0.7 s in
// production — so past this the event goes out without credentials, which
// is then the faster outcome. A variable only for tests.
var voiceMoveRefreshTimeout = 750 * time.Millisecond

// How MoveUser obtained the credentials it embedded, for its log lines.
const (
	voiceMoveCredentialsSnapshot  = "snapshot"  // minted from the move's own access read
	voiceMoveCredentialsRefreshed = "refreshed" // that read had aged; minted from a repeated one
	voiceMoveCredentialsNone      = "none"      // not embedded; the client requests a token
)

// refreshMoveSnapshot repeats the access read behind an aged snapshot: the
// same single statement, for the same user and channel, and nothing else —
// unlike startMoveReads it has no fallback read, because a move that cannot
// embed credentials needs none. false means "no credentials": the read
// failed (ctx expired included), the server has no LiveKit instance or the
// channel is gone (pkg.ErrNotFound), or the answer is not for the channel
// and server the move was decided on. The read gets voiceMoveRefreshTimeout
// within ctx; running out of it is a failed read like any other. Never
// called under s.mu.
func (s *voiceService) refreshMoveSnapshot(ctx context.Context, userID string, aged voiceMoveSnapshot) (voiceMoveSnapshot, bool) {
	reader := s.voiceAccess
	if reader == nil {
		return voiceMoveSnapshot{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, voiceMoveRefreshTimeout)
	defer cancel()
	channel := aged.admission.Channel
	admission, instance, used, err := reader.VoiceTokenAccess(ctx, userID, channel.ID, time.Now())
	if err != nil {
		if !errors.Is(err, pkg.ErrNotFound) {
			voiceLogger.Warn("voice move credentials not embedded", "channel_id", channel.ID, "err", pkg.ErrText(err))
		}
		return voiceMoveSnapshot{}, false
	}
	if admission == nil || instance == nil || admission.Channel.ID != channel.ID || admission.Channel.ServerID != channel.ServerID {
		return voiceMoveSnapshot{}, false
	}
	return voiceMoveSnapshot{admission: admission, instance: instance, used: used, readAt: time.Now()}, true
}

// moverPermissions returns the mover's permissions in channelID: the read
// startMoveReads already issued for that channel, or — without a snapshot
// reader, or when the target's channel changed since the peek — a direct
// resolve.
func (s *voiceService) moverPermissions(ctx context.Context, reads *voiceMoveReads, moverUserID, channelID string) (models.Permission, error) {
	if reads != nil {
		reads.pending.Wait()
		for _, read := range []*voiceMovePermRead{&reads.source, &reads.target} {
			if read.channelID == channelID {
				return read.perms, read.err
			}
		}
	}
	return s.permResolver.ResolveChannelPermissions(ctx, moverUserID, channelID)
}

// voiceMovePlacement is the moved user's session as MoveUser left it under
// the write lock.
type voiceMovePlacement struct {
	state                 *models.VoiceState
	generation            uint64
	username, displayName string
	granted               bool // placed without ConnectVoice (the force-move grant case)
}

// moveCredentials mints the moved user's LiveKit token and media key for the
// target room from an access snapshot no older than
// voiceMoveCredentialsMaxSnapshotAge, and reports how it got them (one of the
// voiceMoveCredentials* values; "none" exactly when the credentials are nil).
//
// The snapshot is the one MoveUser already read while it is that fresh — no
// further database statement. Once it has aged past the bound (the mover's
// permission reads or the lock kept the move waiting) the access read is
// repeated: one statement, at most once per move, with MoveUser's ctx cut
// to voiceMoveRefreshTimeout, here after the unlock. The repeated answer
// replaces the first one for every rule below; the first is not consulted
// again, and reads is not written.
// A first read that found no LiveKit instance is not repeated.
//
// Whichever snapshot it is, the admission rules are the ones GenerateToken
// applies to that same read, with these differences, all following from the
// user already being placed in the target channel by this move:
//   - a missing ConnectVoice is authorised by the placement, exactly like
//     the one-time force-move grant — but s.forceMoveGrants is NOT consumed
//     here, so a client that ignores the embedded credentials (or falls back
//     to an HTTP token request) can still use the grant;
//   - the user limit is not checked: GenerateToken exempts a user who is
//     already in the channel.
//
// nil means "send the event without credentials"; the client then requests a
// token as it always has, and GenerateToken makes the full decision. That is
// the answer whenever this path cannot stand in for GenerateToken: no
// snapshot reader, no LiveKit instance, a timed-out or no-longer-member
// user, a user without ConnectVoice whom this move did not place by grant,
// an instance that is inside its auto-switch threshold (GenerateToken may
// migrate the server to another instance there — never decide a room's
// instance from here), any signing failure, a session that moved on while
// the token was minted, a repeated read that failed (refreshMoveSnapshot),
// or a snapshot — the repeated one included, there is no second repeat —
// that has aged past the bound by the time the credentials would leave.
// The move itself never fails because of this.
//
// What remains is the residual every issued token has (see voiceTokenTTL): a
// sanction committed inside that bound, or after the token is out, meets a
// token that is already valid. The in-memory placement check below and the
// LiveKit participant_joined webhook (EnforceModerationOnJoin) are what
// catch those.
func (s *voiceService) moveCredentials(ctx context.Context, reads *voiceMoveReads, placement voiceMovePlacement, userID string) (*models.VoiceTokenResponse, string) {
	if reads == nil || reads.instance == nil {
		return nil, voiceMoveCredentialsNone
	}
	// A copy: whatever is read again below stays in this call.
	snapshot, source := reads.voiceMoveSnapshot, voiceMoveCredentialsSnapshot
	if snapshot.stale() {
		refreshed, ok := s.refreshMoveSnapshot(ctx, userID, snapshot)
		if !ok {
			return nil, voiceMoveCredentialsNone
		}
		snapshot, source = refreshed, voiceMoveCredentialsRefreshed
	}
	admission, instance := snapshot.admission, snapshot.instance
	if admission.Channel.ServerID == "" || validateVoiceAdmission(admission) != nil {
		return nil, voiceMoveCredentialsNone
	}
	if !admission.Permissions.Has(models.PermConnectVoice) && !placement.granted {
		return nil, voiceMoveCredentialsNone
	}
	if instance.IsPlatformManaged && instance.AutoSwitchEnabled && liveKitInstanceNearQuota(instance, snapshot.used) {
		return nil, voiceMoveCredentialsNone
	}

	apiKey, apiSecret, err := s.liveKitCredentials(userID, instance)
	if err != nil {
		voiceLogger.Warn("voice move credentials not embedded", "channel_id", admission.Channel.ID, "err", pkg.ErrText(err))
		return nil, voiceMoveCredentialsNone
	}
	voice, err := s.issueVoiceToken(voiceTokenIssue{
		userID: userID, username: placement.username, displayName: placement.displayName,
		serverID: admission.Channel.ServerID, channelID: admission.Channel.ID,
		url: instance.URL, apiKey: apiKey, apiSecret: apiSecret,
		permissions: admission.Permissions,
	})
	if err != nil {
		voiceLogger.Warn("voice move credentials not embedded", "channel_id", admission.Channel.ID, "err", pkg.ErrText(err))
		return nil, voiceMoveCredentialsNone
	}

	// The placement is what authorised this token. If the session was ended
	// or moved again since the unlock (leave, kick, another move), whoever
	// did that has already revoked what it stood for.
	s.mu.RLock()
	placed := s.states[userID] == placement.state && placement.state.ChannelGeneration == placement.generation
	s.mu.RUnlock()
	// Minting takes s.mu and may have waited; the age of the snapshot that
	// was minted from is judged again at the moment the credentials would
	// leave. A repeated read that has aged too is not repeated again.
	if !placed || snapshot.stale() {
		return nil, voiceMoveCredentialsNone
	}
	return voice, source
}

// AdminDisconnectUser force-disconnects a user from voice.
// Requires PermMoveMembers in the target's current channel (same as Discord).
// A-37 follow-up: this is an independent state-removal path, not a
// delegation to LeaveChannel (voice_state.go) — it does its own
// delete(s.states, ...) and broadcasts, so its screen-share close-out below
// is its own call to closeOutScreenShareLocked (voice_screenshare.go), not
// inherited from anywhere. Same helper call as MoveUser.
func (s *voiceService) AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error {
	finishOperation, admitted := s.operations.begin()
	if !admitted {
		return context.Canceled
	}
	defer finishOperation()

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
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": pkg.ErrText(err),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if !effectivePerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required", pkg.ErrForbidden)
	}

	channelID, serverID := state.ChannelID, state.ServerID
	s.disconnectVoiceLocked(targetUserID, state)

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

// disconnectVoiceLocked releases s.mu after removing the session and rotating room keys.
func (s *voiceService) disconnectVoiceLocked(targetUserID string, state *models.VoiceState) {
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
	disconnectUsageSessionID := state.UsageSessionID
	disconnectInstanceID := state.LiveKitInstanceID
	disconnectIsCloud := state.LiveKitIsCloud
	delete(s.states, targetUserID)
	delete(s.forceMoveGrants, targetUserID)

	s.broadcastToServerLocked(serverID, ws.Event{
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
	rotationEpochs := make(map[string]uint32, len(rotatedRooms))
	rotationContexts := make(map[string]string, len(rotatedRooms))
	for roomName := range rotatedRooms {
		rotationEpochs[roomName] = s.roomKeyVersions[roomName]
		rotationContexts[roomName] = s.roomKeyContexts[roomName]
	}

	s.mu.Unlock()

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpVoiceForceDisconnect,
	})

	// Push the new passphrase to remaining channel members so they re-key
	// their LiveKit session. The just-kicked user is intentionally excluded.
	for roomName, newPassphrase := range rotatedRooms {
		s.hub.BroadcastToUsers(remaining, ws.Event{
			Op: ws.OpVoicePassphraseRotated,
			Data: ws.VoicePassphraseRotatedData{
				ChannelID:  channelID,
				Passphrase: newPassphrase,
				KeyIndex:   rotationEpochs[roomName] % 256,
				KeyEpoch:   uint64(rotationEpochs[roomName]),
				KeyContext: rotationContexts[roomName],
			},
		})
	}

	// Dual-identity (A-29d): AdminDisconnectUser ends the target's whole
	// voice session (same as LeaveChannel), so a screen share they were
	// running must end with it — a force-disconnected user's "_ss"
	// sub-participant would otherwise keep streaming after their main
	// connection is gone, same MEDIUM finding removeParticipantAndScreenShareFromLiveKit
	// was added for.
	s.dispatchDisconnectCleanup(func() { s.removeParticipantAndScreenShareFromLiveKit(channelID, targetUserID) })
	// F4 review MEDIUM fix: credit the force-ended session's duration to
	// its cloud instance's monthly bucket — mirrors LeaveChannel's
	// go s.creditUsage(...) dispatch. Self-hosted, zero-duration, and
	// unset cases are no-ops inside creditUsage itself.
	s.dispatchUsageCredit(disconnectUsageSessionID, disconnectInstanceID, disconnectIsCloud, disconnectJoinedAt, time.Now()) // #nosec G118 -- deliberately detached: quota crediting must complete even if the caller's context is cancelled, mirroring LeaveChannel's own dispatch

	// F2 review MEDIUM fix: channelID emptied by this disconnect (remaining
	// computed above under the lock, right after delete) → kick the music
	// bot (if any), mirroring LeaveChannel's "Channel emptied → kick the
	// music bot" dispatch (same nil-guard, same StopAllForChannel call).
	if len(remaining) == 0 && s.musicBotHook != nil {
		s.dispatchDisconnectCleanup(func() { s.musicBotHook.StopAllForChannel(channelID) })
	}

}
