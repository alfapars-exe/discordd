// Package services — voice channel join/leave/update and state queries.
// Owns the central `states` map lifecycle; all mutations happen here or in
// voice_admin.go. Lock discipline: every state mutation is bracketed by s.mu.
package services

import (
	"context"
	"errors"
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

// authorizeJoin gates JoinChannel (N-01): the caller must be an active
// member of the channel's server AND hold PermConnectVoice on the channel
// — unless they're the target of a live force-move grant for this exact
// channel (see MoveUser in voice_admin.go). Also rejects currently
// timed-out users (matches the GenerateToken gate in voice_token.go) —
// this covers WS reconnect / same-session rejoin paths that skip a fresh
// token request, including force-move, so a muted user can't re-enter
// voice through any route while their timeout is active.
func (s *voiceService) authorizeJoin(ctx context.Context, userID, serverID, channelID string) error {
	isMember, err := s.afkTimeoutGetter.IsMember(ctx, serverID, userID)
	if err != nil {
		return fmt.Errorf("failed to check server membership: %w", err)
	}
	if !isMember {
		return fmt.Errorf("%w: not a member of this server", pkg.ErrForbidden)
	}

	if s.timeoutChecker != nil && serverID != "" {
		active, err := s.timeoutChecker.IsActive(ctx, serverID, userID)
		if err != nil {
			return fmt.Errorf("check timeout: %w", err)
		}
		if active {
			return fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if effectivePerms.Has(models.PermConnectVoice) {
		return nil
	}
	// Already placed in this exact channel — accept without PermConnectVoice.
	//
	// This is what actually carries the force-move case. The client requests
	// the LiveKit token BEFORE it sends voice_join (voiceEventHandlers.ts), and
	// GenerateToken *consumes* the one-time grant, so by the time we get here
	// hasForceMoveGrant is already false and the grant check below never fires
	// for a real client. MoveUser has meanwhile written the new ChannelID into
	// the user's state, so "state already says this channel" is the durable
	// signal that an admin authorized the placement.
	//
	// Not a bypass: states[userID].ChannelID is only ever written by a
	// JoinChannel that passed this same gate, or by MoveUser, which checks the
	// mover's permissions. Server membership is still required above — a user
	// removed from the server after being moved does not get back in.
	if s.alreadyInChannel(userID, channelID) {
		return nil
	}
	// Kept for the non-client callers (and the token-first ordering is not
	// contractual): a grant that has not been consumed yet still authorizes.
	if s.hasForceMoveGrant(userID, channelID) {
		return nil
	}
	return fmt.Errorf("%w: missing voice connect permission", pkg.ErrForbidden)
}

// alreadyInChannel reports whether userID's current voice state is already this
// exact channel. Read-locked: authorizeJoin runs before JoinChannel takes the
// write lock.
func (s *voiceService) alreadyInChannel(userID, channelID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[userID]
	return ok && st.ChannelID == channelID
}

// currentServerMute reports whether userID currently holds an active
// server-mute sanction on serverID, read from their live in-memory voice
// state (IsServerMuted is session-scoped in-memory state, not persisted —
// see AdminUpdateState's doc comment in voice_admin.go). Used by
// GenerateToken (voice_token.go) to fold the sanction into the LiveKit
// publish grant at token-issuance time.
//
// No state at all → false, not an ambiguous default: AdminUpdateState
// requires an existing voice state to set IsServerMuted in the first place
// (`state, ok := s.states[targetUserID]; if !ok { return ErrBadRequest }`),
// so a user with no state has never had the chance to be muted — "no
// state" and "not muted" are the same fact here.
//
// Scoped to serverID, not channelID: IsServerMuted is a server-wide
// sanction (A-38 review — it survives a same-server channel switch, dropped
// only on a cross-server one), so this must match whatever server the
// token is actually being requested for, not whatever channel the user's
// (possibly stale, pre-switch) state currently says.
func (s *voiceService) currentServerMute(userID, serverID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.states[userID]
	return ok && state.ServerID == serverID && state.IsServerMuted
}

// hasForceMoveGrant reports whether userID holds a live (unexpired,
// channel-matching) force-move grant, without consuming it. GenerateToken
// (voice_token.go) remains the single point that deletes the grant on
// actual token issuance — this is a read-only peek so JoinChannel's
// state-sync call doesn't race the token call for the one-time bypass.
func (s *voiceService) hasForceMoveGrant(userID, channelID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	grant, ok := s.forceMoveGrants[userID]
	return ok && grant.channelID == channelID && time.Now().Before(grant.expiresAt)
}

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error {
	// Resolve channel's parent server before locking — all voice broadcasts are server-scoped.
	ctx := context.Background()
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		// F1 review HIGH fix (our own A-38 regression): the client no
		// longer sends voice_leave on a channel switch — JoinChannel's own
		// cross-channel branch absorbed that responsibility (see its
		// oldChannelID handling below). That means an EARLY failure here,
		// after the client already tore down its old LiveKit connection and
		// requested a token for channelID, used to leave the user's
		// server-side state stuck pointing at the OLD channel forever: that
		// channel never empties (orphaned music bot, passphrase never
		// cleaned up), a stale UserLimit slot stays occupied, and — worst —
		// a later kick/move in that channel calls remainingChannelMembers
		// (voice_e2ee.go), which still counts this ghost entry and pushes
		// the rotated E2EE passphrase to it: exactly the leak class N-01
		// below exists to prevent.
		//
		// F1 review MEDIUM fix (this round): cleanup must NOT run on a
		// transient failure while the user is simply re-confirming the
		// SAME channel. The client resends voice_join for the channel it's
		// already connected to on every WS reconnect while its LiveKit
		// connection stays up (systemEventHandlers.ts), and that hits this
		// lookup BEFORE authorizeJoin's own same-channel fast path
		// (alreadyInChannel, below) ever runs — so a plain transient DB
		// hiccup here (wrapped into the generic error below, NOT
		// pkg.ErrNotFound — repository.sqliteChannelRepo.GetByID only
		// returns the bare pkg.ErrNotFound sentinel for a genuinely
		// missing row, sql.ErrNoRows) would otherwise run LeaveChannel on
		// a live, actively-streaming session: state deleted, leave
		// broadcast, quota credited early, and the user evicted from the
		// LiveKit room they're still connected to. Before this round that
		// same transient failure was a silently logged no-op. Gate: only
		// clean up if the user is genuinely switching away from a
		// DIFFERENT channel (or has no state at all — !alreadyInChannel
		// covers both), OR the rejection is AUTHORITATIVE (the channel is
		// really gone). The sentinel check MUST run against the raw err
		// here, before it gets flattened into the generic
		// "%w: channel not found" return below — that flattened value
		// would satisfy errors.Is(..., pkg.ErrNotFound) unconditionally
		// regardless of what err actually was.
		if !s.alreadyInChannel(userID, channelID) || errors.Is(err, pkg.ErrNotFound) {
			// s.LeaveChannel is idempotent (no-op if there's no stale
			// state, e.g. this is a genuinely fresh join).
			if leaveErr := s.LeaveChannel(userID); leaveErr != nil {
				// Unreachable today — LeaveChannel has no error path (see
				// its own signature/body) — kept defensively so a future
				// non-nil return doesn't silently vanish; not an observed
				// failure mode.
				voiceLogger.Error("JoinChannel: stale-state cleanup after early failure also failed", "user_id", userID, "err", pkg.ErrText(leaveErr))
			}
		}
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	serverID := channel.ServerID

	// N-01: reject phantom voice-state injection. Without this gate a WS
	// client could send voice_join for a channel it was never authorized
	// to enter — the resulting ghost state is counted by
	// remainingChannelMembers/UserLimit and, worse, receives the plaintext
	// SFrame E2EE passphrase on the channel's next rotation (voice_e2ee.go).
	if err := s.authorizeJoin(ctx, userID, serverID, channelID); err != nil {
		// F1 review HIGH fix — same rationale as the channel-lookup failure
		// above: a legitimate rejection here (e.g. a moderator applied a
		// timeout in the window between the client requesting its LiveKit
		// token and sending voice_join) must not leave the user's
		// server-side state stuck in the OLD channel either.
		//
		// F1 review MEDIUM fix (this round): same "authoritative rejection
		// or genuine switch only" guard as the lookup branch above — a
		// same-channel WS-reconnect resend hits authorizeJoin too (its own
		// same-channel fast path, alreadyInChannel below, only short-
		// circuits authorizeJoin's INTERNAL logic; it doesn't change that
		// authorizeJoin can still fail on the way there). A transient
		// IsMember/IsActive/ResolveChannelPermissions DB error wraps into a
		// plain error, NOT pkg.ErrForbidden, so errors.Is below correctly
		// tells that apart from authorizeJoin's genuine ErrForbidden
		// rejections (not a member, timed out, missing ConnectVoice) —
		// unlike the lookup branch above, authorizeJoin's own returns are
		// already correctly un-flattened, so checking err directly (not a
		// separately-captured raw value) is correct here.
		if !s.alreadyInChannel(userID, channelID) || errors.Is(err, pkg.ErrForbidden) {
			if leaveErr := s.LeaveChannel(userID); leaveErr != nil {
				// Unreachable today — see the identical note on the lookup
				// branch above.
				voiceLogger.Error("JoinChannel: stale-state cleanup after early failure also failed", "user_id", userID, "err", pkg.ErrText(leaveErr))
			}
		}
		return err
	}

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
	// A-38 review regression fix: the client no longer sends voice_leave on
	// a channel switch (this cross-channel branch already covers the leave
	// side that was the root-cause fix), so LeaveChannel's "is the old
	// channel now humanless" scan — which drives stopping an abandoned
	// music bot — never ran for a switch either. oldChannelEmpty mirrors
	// that scan for oldChannelID; see its dispatch below (after unlock) for
	// why it's needed and why it's a copy of LeaveChannel's check rather
	// than a shared helper.
	var oldChannelEmpty bool
	// A-37 follow-up: server-mute/deafen carry-over. Unlike IsStreaming
	// (screen share does NOT follow — see the fresh-state construction
	// comment below), server-mute/deafen is a moderation sanction, not a
	// media stream, and Discord-parity behavior is that it survives the
	// target's OWN-SERVER channel switch — only an explicit unmute/undeafen
	// by a privileged actor (AdminUpdateState) lifts it early. These
	// default to false (correct for a genuine first-time join, which has
	// no prior state to carry anything over from) and are only set from
	// `existing` below, gated to oldServerID == serverID (A-38 review
	// MEDIUM, see that check's own comment): the sanction is SERVER-scoped
	// moderation, so it must not cross into a different server's voice
	// channel that server's own moderators never applied it on.
	var wasServerMuted, wasServerDeafened bool

	s.mu.Lock()

	// Leave current channel if in one
	if existing, ok := s.states[userID]; ok {
		oldChannelID = existing.ChannelID
		oldServerID = existing.ServerID
		oldJoinedAt = existing.JoinedAt
		oldInstanceID = existing.LiveKitInstanceID
		oldIsCloud = existing.LiveKitIsCloud
		// A-37: snapshotted before the cross-channel branch below replaces
		// this user's state with a fresh one that has IsStreaming=false —
		// see that construction's comment for why a stream never carries
		// over to the new channel.
		wasStreaming := existing.IsStreaming
		// A-38 review MEDIUM fix: only carry the server-mute/deafen sanction
		// into the new state when the switch stays on the SAME server.
		// server-mute/deafen is applied by a moderator with
		// PermMuteMembers/PermDeafenMembers on ONE specific server
		// (AdminUpdateState resolves permissions against the target's
		// CURRENT channel) — without this gate, a sanction server A's
		// moderator applied would silently follow the user into server B's
		// voice channel the moment they switch servers, muting/badging them
		// there with zero action from any of server B's moderators. If
		// oldServerID != serverID, wasServerMuted/wasServerDeafened simply
		// keep their zero-value default (false) from the declaration above.
		if oldServerID == serverID {
			wasServerMuted = existing.IsServerMuted
			wasServerDeafened = existing.IsServerDeafened
		}

		// Same-channel rejoin (WS reconnect) — silently refresh state, no
		// broadcast. This prevents false leave/join sounds for everyone in
		// the channel. Quota fields (JoinedAt / LiveKitInstanceID /
		// LiveKitIsCloud) are preserved so the eventual leave still
		// attributes the full session duration, not just the time since the
		// last reconnect. IsServerMuted/IsServerDeafened (and IsStreaming)
		// aren't touched at all here — `existing` is mutated in place, not
		// replaced, so a reconnect can never itself clear a moderation
		// sanction or an in-progress stream.
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

		// Screen-share close-out for oldChannelID — since from the old
		// channel's perspective a cross-channel switch IS a leave. See
		// closeOutScreenShareLocked (voice_screenshare.go).
		s.closeOutScreenShareLocked(userID, oldChannelID, oldServerID, wasStreaming)

		s.cleanupRoomPassphraseIfEmpty(oldChannelID)

		// oldChannelID is now humanless if no one else's voice state
		// references it — same scan LeaveChannel runs for its own channelID
		// (voice_state.go LeaveChannel, "Channel is now humanless..."
		// comment). Copied rather than shared: this is plain inline logic
		// duplicated across the two functions on purpose for now (matches
		// closeOutScreenShareLocked's siblings before that helper was
		// extracted) — if a third site needs it, factor both into a shared
		// helper together. Until then, a change to one MUST be mirrored in
		// the other by hand, which is exactly the kind of drift that caused
		// this regression in the first place (LeaveChannel's own copy of
		// this check existed the whole time; this branch's parallel case
		// was simply never added when the client's leave-on-switch
		// behavior changed).
		oldChannelEmpty = true
		for _, st := range s.states {
			if st.ChannelID == oldChannelID {
				oldChannelEmpty = false
				break
			}
		}
	}

	// Two deliberately asymmetric carry-over decisions for the fresh state
	// below, both explained here so the symmetry (or lack of it) isn't lost
	// on a future reader:
	//   - IsStreaming is left unset (zero value: false) — same decision as
	//     MoveUser (voice_admin.go): a screen share is a separate LiveKit
	//     connection tied to the OLD channel's room, this call never
	//     reconnects it to the new one, and the cleanup above already closed
	//     it out for oldChannelID. The client must explicitly restart screen
	//     sharing in channelID if it wants to keep streaming there — a
	//     stream doesn't move, it restarts.
	//   - IsServerMuted/IsServerDeafened (wasServerMuted/wasServerDeafened,
	//     snapshotted above) ARE carried over within the SAME server (see
	//     the oldServerID == serverID gate above; a cross-server switch
	//     drops it — A-38 review MEDIUM) — Discord parity: server-mute/
	//     deafen is a moderation sanction applied by a privileged actor
	//     (AdminUpdateState), not a media stream, so the target's own
	//     voluntary same-server channel switch must not silently lift it.
	//     This sanction is session-scoped in-memory state, not persisted: a
	//     full departure from voice (LeaveChannel, AdminDisconnectUser, or
	//     the orphan sweep, voice_lifecycle.go) deletes the whole
	//     VoiceState and the sanction goes with it — WITHIN a single live
	//     session, only an explicit AdminUpdateState(..., false) lifts it
	//     early (A-38 review LOW: this comment previously, wrongly, implied
	//     AdminUpdateState was the only way it ever goes away, full stop).
	//     Enforcement (A-38 review LOW item, closed in a later round): this
	//     flag IS now wired into the LiveKit publish grant — GenerateToken
	//     (voice_token.go) gates canPublish on it at (re)connect,
	//     AdminUpdateState's applyServerMuteToLiveKit dispatch
	//     (voice_admin.go/voice_lifecycle.go) re-authorizes a LIVE session
	//     mid-call, and EnforceModerationOnJoin (voice_lifecycle.go) closes
	//     the token-TTL/channel-switch gap between the two. All three are a
	//     HARDENING layer on top of this field, not a second source of
	//     truth: IsServerMuted here remains the one authoritative record,
	//     and only a full departure from voice (see above) ever clears it.
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
		IsServerMuted:     wasServerMuted,
		IsServerDeafened:  wasServerDeafened,
		LastActivity:      now,
		JoinedAt:          now,
		LiveKitInstanceID: lkInstanceID,
		LiveKitIsCloud:    lkIsCloud,
	}

	// IsServerMuted/IsServerDeafened included so a moved-in user's
	// moderation-sanction badges render correctly for everyone else in the
	// target channel immediately, not just after their next own state
	// change (see the carry-over decision above the state construction).
	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           userID,
			ChannelID:        channelID,
			Username:         username,
			DisplayName:      displayName,
			AvatarURL:        avatarURL,
			IsServerMuted:    wasServerMuted,
			IsServerDeafened: wasServerDeafened,
			IsMuted:          isMuted,
			IsDeafened:       isDeafened,
			Action:           "join",
		},
	})

	s.mu.Unlock()

	// Remove phantom participant from old LiveKit room (best-effort, outside
	// lock). Dual-identity (A-29d): the fresh models.VoiceState built above
	// doesn't carry IsStreaming forward from the old state, so a user who
	// switches channels while screen sharing is no longer tracked as
	// streaming at all server-side — but their "_ss" LiveKit sub-participant
	// is a separate connection that this JoinChannel call never touches, so
	// it's left connected to oldChannelID's room until the client
	// independently reconnects/tears it down. Same orphaned-stream risk as
	// MoveUser and AdminDisconnectUser, so it gets the same cleanup.
	if oldChannelID != "" && oldChannelID != channelID {
		go s.removeParticipantAndScreenShareFromLiveKit(oldChannelID, userID)
		// Cross-channel switch — credit the old session's duration to the
		// instance it ran on. Self-hosted instances are skipped.
		go s.creditUsage(oldInstanceID, oldIsCloud, oldJoinedAt)

		// oldChannelID emptied by this switch → kick the music bot (if any),
		// mirroring LeaveChannel's "Channel emptied → kick the music bot"
		// dispatch (same nil-guard, same StopAllForChannel call). See
		// oldChannelEmpty's own comment (above, still under the lock) for
		// why this exists as a second, hand-synced copy of that check.
		if oldChannelEmpty && s.musicBotHook != nil {
			go s.musicBotHook.StopAllForChannel(oldChannelID)
		}

		// F8 review LOW fix: same log line/format LeaveChannel emits (see
		// its own "user left voice channel" log below), so a switch is
		// visible in log analysis the same way an explicit leave is —
		// previously only the "user joined voice channel" half of a switch
		// was logged, which contributed to both this round's regressions
		// (F1's stale state, the earlier music-bot-stop gap) going
		// unnoticed for as long as they did.
		voiceLogger.Info("user left voice channel", "user_id", userID, "channel_id", oldChannelID)
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

	// Clean up screen share viewer tracking for the leaving user (own
	// stream ends + viewer-of-others cleanup) — see
	// closeOutScreenShareLocked (voice_screenshare.go).
	s.closeOutScreenShareLocked(userID, channelID, serverID, wasStreaming)

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

	// Remove from LiveKit (best-effort, outside lock — involves DB calls).
	// Dual-identity: also evicts the "_ss" screen-share sub-participant, if
	// any, so a departing user's screen share doesn't keep streaming after
	// their voice connection is gone (DisconnectUser routes through this
	// same LeaveChannel, so it's covered too).
	go s.removeParticipantAndScreenShareFromLiveKit(channelID, userID)
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
