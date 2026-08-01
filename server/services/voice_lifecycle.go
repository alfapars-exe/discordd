// Package services — background voice goroutines and LiveKit cleanup.
// Orphan state sweep handles abandoned WS connections; AFK sweep kicks users
// who have been idle longer than their server's afk_timeout_minutes.
package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/ws"

	livekit "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"google.golang.org/protobuf/proto"
)

// orphanGracePeriod is the guaranteed minimum time a user must be offline
// before their voice state is cleaned up. Prevents false leave/join broadcasts
// (and sounds) during brief WS reconnects. The old fixed-ticker approach gave
// 0–30s of grace depending on phase alignment; per-user timestamps guarantee
// the full duration regardless of when the disconnect happens.
const orphanGracePeriod = 35 * time.Second

type orphanEntry struct {
	userID            string
	channelID         string
	joinedAt          time.Time
	livekitInstanceID string
	livekitIsCloud    bool
	// channelEmpty — F3 review MEDIUM fix: whether channelID had no other
	// voice members left once this orphan's state was removed (scanned
	// under the lock, mirroring LeaveChannel's channelEmpty). Drives the
	// music-bot-stop dispatch after the lock is released, below.
	channelEmpty bool
}

type afkEntry struct {
	userID      string
	channelID   string
	channelName string
	serverID    string
	serverName  string
}

// UpdateActivity resets the AFK timer for a user (called on mouse/keyboard/VAD/screen share activity).
func (s *voiceService) UpdateActivity(userID string) {
	s.mu.Lock()
	if state, ok := s.states[userID]; ok {
		state.LastActivity = time.Now()
	}
	s.mu.Unlock()
}

// StartOrphanCleanup periodically removes voice states for users who have been
// disconnected longer than orphanGracePeriod. Runs every 5s for responsive
// cleanup after grace expires — per-user timestamps prevent premature removal.
func (s *voiceService) StartOrphanCleanup() {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepOrphanStates()
		}
	}()
}

// sweepOrphanStates uses two-phase per-user tracking:
//  1. First time a user with voice state is seen offline → record offlineSince timestamp
//  2. User comes back online before grace expires → clear tracking, no broadcast
//  3. Grace period expires → broadcast leave, remove state, cleanup LiveKit
//
// This guarantees orphanGracePeriod of grace regardless of ticker phase.
func (s *voiceService) sweepOrphanStates() {
	onlineIDs := s.onlineChecker.GetOnlineUserIDs()
	onlineSet := make(map[string]bool, len(onlineIDs))
	for _, id := range onlineIDs {
		onlineSet[id] = true
	}

	now := time.Now()
	var orphans []orphanEntry

	s.mu.Lock()

	// Phase 1: Track newly offline users, clear returned-online users
	for userID := range s.states {
		if onlineSet[userID] {
			// Back online — clear any pending offline tracking
			delete(s.offlineSince, userID)
		} else if _, tracked := s.offlineSince[userID]; !tracked {
			// First time seeing this user offline — start grace timer
			s.offlineSince[userID] = now
		}
	}

	// Phase 2: Only remove users who exceeded the grace period
	for userID, offlineTime := range s.offlineSince {
		if now.Sub(offlineTime) < orphanGracePeriod {
			continue // Still within grace — do not touch
		}

		state, ok := s.states[userID]
		if !ok {
			// Voice state already removed (explicit leave during grace) — clean tracker
			delete(s.offlineSince, userID)
			continue
		}

		// Grace expired — confirmed abandoned session
		channelID := state.ChannelID
		serverID := state.ServerID
		username := state.Username
		displayName := state.DisplayName
		avatarURL := state.AvatarURL
		joinedAt := state.JoinedAt
		instanceID := state.LiveKitInstanceID
		isCloud := state.LiveKitIsCloud
		// F5 review MEDIUM fix: snapshotted before delete, same pattern as
		// LeaveChannel's wasStreaming — drives the closeOutScreenShareLocked
		// call below.
		wasStreaming := state.IsStreaming
		delete(s.states, userID)
		delete(s.offlineSince, userID)

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

		// F5 review MEDIUM fix: screen-share close-out — without this, a
		// user whose WS connection dropped while WATCHING someone else's
		// screen share was never removed from that streamer's
		// screenShareViewers set (only LeaveChannel/AdminDisconnectUser/
		// MoveUser/JoinChannel's cross-channel branch ran this; the orphan
		// sweep — the path a closed tab or lost connection with no
		// beforeunload/pagehide actually takes — never did). The
		// streamer's viewer count stayed permanently inflated, seeded
		// stale into every newly connecting client (ws/handler.go). Same
		// helper, same call shape as every other "this user's presence
		// here is over" site: closeOutScreenShareLocked (voice_screenshare.go).
		s.closeOutScreenShareLocked(userID, channelID, serverID, wasStreaming)

		s.cleanupRoomPassphraseIfEmpty(channelID)

		// F3 review MEDIUM fix: channelEmpty scan, same as LeaveChannel's —
		// this is, in practice, the MOST common way a voice channel
		// actually empties (browser tab close / pagehide sends no
		// voice_leave and always falls through to this 35s sweep instead),
		// so its absence here was the highest-impact of the eight findings
		// in this pass even though it's a straight copy of an existing
		// check.
		channelEmpty := true
		for _, st := range s.states {
			if st.ChannelID == channelID {
				channelEmpty = false
				break
			}
		}

		orphans = append(orphans, orphanEntry{
			userID:            userID,
			channelID:         channelID,
			joinedAt:          joinedAt,
			livekitInstanceID: instanceID,
			livekitIsCloud:    isCloud,
			channelEmpty:      channelEmpty,
		})
		voiceLogger.Info("orphan cleanup: removed stale voice state",
			"user_id", userID, "channel_id", channelID, "offline_for", now.Sub(offlineTime).Round(time.Second))
		// INFO, not WARN: orphan sweep is the documented happy-path
		// recovery (WS disconnect != voice leave, janitor catches the
		// leftover). Flooding the WARN channel with every successful
		// cleanup buries real anomalies in dashboards.
		s.logInfo(models.LogCategoryVoice, &userID, "orphan cleanup: stale voice state removed", map[string]string{
			"channel_id":      channelID,
			"offline_seconds": fmt.Sprintf("%.0f", now.Sub(offlineTime).Seconds()),
		})
	}

	// Clean stale trackers (user left voice explicitly during grace)
	for userID := range s.offlineSince {
		if _, ok := s.states[userID]; !ok {
			delete(s.offlineSince, userID)
		}
	}

	s.mu.Unlock()

	// F3 review LOW fix (this round): music-bot-stop dispatch lives in its
	// own loop, run immediately after unlock and BEFORE the synchronous
	// LiveKit eviction loop below. o.channelEmpty was already decided under
	// the lock, at the top of this sweep pass — but each
	// removeParticipantAndScreenShareFromLiveKit call in that next loop is
	// SYNCHRONOUS and can block up to ~20s (two identities × a 10s LiveKit
	// timeout each), so keeping the stop dispatch inside that loop meant
	// the LAST orphan's decision in an N-orphan pass (e.g. several users
	// dropping in the same network partition) could go stale by ~20·N
	// seconds before it fired. Splitting it out here means every
	// StopAllForChannel call dispatches (via go, so still non-blocking)
	// within moments of the decision being made, not after however many
	// LiveKit round trips happened to precede it in iteration order.
	for _, o := range orphans {
		if o.channelEmpty && s.musicBotHook != nil {
			go s.musicBotHook.StopAllForChannel(o.channelID)
		}
	}

	// LiveKit cleanup outside lock (involves DB calls). Dual-identity
	// (A-29d): s.states (and so orphanEntry.userID above) is keyed only by
	// the main voice identity — a "_ss" screen-share sub-participant is a
	// separate LiveKit connection with no entry of its own in s.states, so
	// it is NOT already caught by this loop; a WS client that drops offline
	// mid-screen-share would otherwise leave its "_ss" identity connected
	// until LiveKit's own ICE/DTLS timeout. This is exactly the "user's
	// whole voice session is confirmed over" case the other three
	// removeParticipantAndScreenShareFromLiveKit call sites cover, so it
	// gets the same treatment here.
	for _, o := range orphans {
		s.removeParticipantAndScreenShareFromLiveKit(o.channelID, o.userID)
		// Credit the abandoned session — duration counts up to the moment
		// of cleanup, which is approximately when the user actually
		// disconnected (within `orphanGracePeriod` of it).
		s.creditUsage(o.livekitInstanceID, o.livekitIsCloud, o.joinedAt)
	}
}

// removeParticipantFromLiveKit explicitly removes a single LiveKit identity
// from channelID's room. Without this, phantom participants linger until
// ICE/DTLS timeout. Best-effort: errors are logged but not propagated.
// MUST NOT be called under mu.Lock (does DB lookups).
//
// identity is usually userID (the main voice connection) but may also be
// userID+"_ss" (a screen-share sub-participant, see GenerateScreenShareToken
// in voice_token.go) — removeParticipantAndScreenShareFromLiveKit below
// calls this once per identity for callers where a user's whole voice
// session is ending and any screen share they were running should end too.
func (s *voiceService) removeParticipantFromLiveKit(channelID, identity string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		voiceLogger.Error("removeParticipant: channel lookup failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &identity, "removeParticipant: channel lookup failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		voiceLogger.Error("removeParticipant: livekit instance lookup failed", "server_id", channel.ServerID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &identity, "removeParticipant: LiveKit instance lookup failed", map[string]string{
			"server_id": channel.ServerID, "channel_id": channelID, "error": err.Error(),
		})
		return
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		voiceLogger.Error("removeParticipant: api key decrypt failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &identity, "removeParticipant: API key decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		voiceLogger.Error("removeParticipant: api secret decrypt failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &identity, "removeParticipant: API secret decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	roomName := channel.ServerID + ":" + channelID
	roomClient := lksdk.NewRoomServiceClient(lkInstance.URL, apiKey, apiSecret)

	_, err = roomClient.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     roomName,
		Identity: identity,
	})
	if err != nil {
		meta := map[string]string{"room": roomName, "channel_id": channelID, "error": err.Error()}
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			// Expected when the participant already left LiveKit (e.g. network drop, orphan sweep after LiveKit
			// timeout), or — for a "_ss" identity — when the user simply never screen-shared. Logged at INFO so the
			// WARN channel stays meaningful — this branch always represents an unremarkable outcome.
			voiceLogger.Info("removeParticipant: participant already gone (not found)", "user_id", identity, "room", roomName)
			s.logInfo(models.LogCategoryVoice, &identity, "removeParticipant: participant already left LiveKit", meta)
		} else {
			voiceLogger.Error("removeParticipant: LiveKit API call failed", "user_id", identity, "room", roomName, "err", pkg.ErrText(err))
			s.logError(models.LogCategoryVoice, &identity, "removeParticipant: LiveKit API call failed", meta)
		}
		return
	}

	voiceLogger.Info("removeParticipant: successfully removed participant", "user_id", identity, "room", roomName)
}

// removeParticipantAndScreenShareFromLiveKit evicts both a user's main
// voice connection (identity == userID) and their screen-share
// sub-participant, if any (identity == userID+"_ss"). Used by every path
// where "this user's presence in channelID is over" — LeaveChannel/
// DisconnectUser and the cross-channel branch of JoinChannel
// (voice_state.go), EnforceModerationOnJoin and the orphan sweep (this
// file), and MoveUser/AdminDisconnectUser (voice_admin.go) — should also
// end anything they were broadcasting there; a plain
// removeParticipantFromLiveKit(channelID, userID) call only ever targeted
// the main identity, which left a moderated, departed, moved, or
// disconnected user's screen share running to the room. Two independent,
// sequential, best-effort
// removeParticipantFromLiveKit calls (not a single shared LiveKit client)
// — simpler than threading a shared client through, and this is a rare
// background path, not a hot one, so the extra channel/instance lookup is
// cheap. If the user never screen-shared, the second call's "_ss" identity
// is a normal not-found (logged at INFO, see removeParticipantFromLiveKit).
func (s *voiceService) removeParticipantAndScreenShareFromLiveKit(channelID, userID string) {
	s.removeParticipantFromLiveKit(channelID, userID)
	s.removeParticipantFromLiveKit(channelID, userID+"_ss")
}

// buildServerMutePermission returns the ParticipantPermission to send to
// UpdateParticipant for a server-mute/unmute transition: every field from
// current copied forward unchanged EXCEPT CanPublish, which becomes
// !muted. Pure and side-effect-free on purpose — this is the one piece of
// applyServerMuteToLiveKit's logic actually worth unit-testing in
// isolation (LiveKit's UpdateParticipantRequest.Permission REPLACES the
// whole object when set, so a bug here would silently strip an unrelated
// permission field like CanSubscribe/CanPublishData from a live
// participant — the exact regression class this whole task is guarding
// against).
//
// Uses proto.Clone, not a field-by-field struct literal copy and not a
// plain `*current` value copy (review LOW fix): a field-by-field copy's
// claimed safety net — "a future ParticipantPermission field fails to
// compile here" — is false; Go's keyed struct literals compile fine with
// unset fields, so a protocol-library bump adding a new permission field
// would silently drop it from every server-muted participant instead of
// failing loudly. proto.Clone deep-copies every field, including ones
// added after this code was written, with no maintenance needed here. A
// plain `*current` copy was also not an option: livekit.ParticipantPermission
// carries protobuf-internal state that go vet's copylocks check flags on
// direct struct-value copies.
//
// current may be nil (LiveKit hadn't reported a permission for this
// participant yet) — falls back to the same CanSubscribe/CanPublishData
// defaults GenerateToken issues (voice_token.go) so that edge case still
// leaves the participant able to subscribe and send data.
func buildServerMutePermission(current *livekit.ParticipantPermission, muted bool) *livekit.ParticipantPermission {
	if current == nil {
		return &livekit.ParticipantPermission{CanSubscribe: true, CanPublishData: true, CanPublish: !muted}
	}
	perm, ok := proto.Clone(current).(*livekit.ParticipantPermission)
	if !ok {
		// Unreachable in practice — proto.Clone on a *ParticipantPermission
		// always returns the same concrete type. Kept as a defensive fail-
		// safe (a sane default, not a panic, if that ever stops holding)
		// rather than trusting a failed type assertion's zero value.
		return &livekit.ParticipantPermission{CanSubscribe: true, CanPublishData: true, CanPublish: !muted}
	}
	perm.CanPublish = !muted
	return perm
}

// serverMuteUnmuteRetryBackoffs is the backoff schedule applyServerMuteToLiveKit's
// unmute leg sleeps between retry attempts (review HIGH-2 fix). A package
// var rather than a local literal purely for test speed: a test pinning
// "retries exhaust, then eviction" needs to actually observe every attempt,
// and the real ~7s schedule (1s+2s+4s) would make that test slow without
// adding any coverage value — tests may shrink this var (and MUST restore
// it afterward, since it's shared package state) rather than sleep through
// production timing. Not exposed as constructor config: no product
// requirement to tune this at runtime, only a testability one.
var serverMuteUnmuteRetryBackoffs = []time.Duration{1 * time.Second, 2 * time.Second, 4 * time.Second}

// applyServerMuteToLiveKit re-authorizes userID's LiveKit publish grant in
// channelID to match their CURRENT server-mute state (AdminUpdateState,
// voice_admin.go) — this is the mid-session hardening half of closing the
// gap where IsServerMuted was purely a client-side advisory (useMicSync);
// GenerateToken (voice_token.go) is the (re)connect half, and
// EnforceModerationOnJoin (below) closes the token-TTL freeze window in
// between. All three sit on top of the SAME source of truth — IsServerMuted
// on the in-memory, session-scoped VoiceState (see currentServerMute's own
// doc comment, voice_state.go, for what "session-scoped" means: a full
// departure from voice, not just this LiveKit push, is what actually lifts
// the sanction). This function never becomes a second, independent record
// of "is this user muted" — it only ever pushes that existing truth
// outward into LiveKit.
//
// Takes no muted parameter (review MEDIUM-1 fix): re-derives the CURRENT
// truth via currentServerMute AFTER resolving channel.ServerID below,
// rather than trusting a value the caller captured at dispatch time. A
// rapid mute→unmute (or unmute→mute) pair can dispatch two of these that
// then complete out of order (the mute leg's own call site dispatches
// fire-and-forget); re-deriving here means whichever call actually
// executes LAST converges on the real current state instead of whatever
// it was started with.
//
// Deliberately NOT factored to share code with removeParticipantFromLiveKit
// despite the identical channel/instance/key setup: this call can silence
// a LIVE, currently-flowing audio stream (higher-risk surface than evicting
// an already-departed participant), so it gets its own fully independent
// code path rather than adding a new branch to a function every other
// voice-session-teardown site already relies on. Mirrors its client-setup
// and not_found-tolerant error-handling pattern (attemptServerMuteUpdate,
// below). MUST NOT be called under mu.Lock (does DB lookups + network
// calls) — see its call sites' own comments for why that's safe.
//
// muted (as re-derived) true: flips CanPublish to false via
// UpdateParticipant (buildServerMutePermission preserves every other
// permission field) and, best-effort, mutes the already-published
// microphone track directly via MutePublishedTrack — UpdateParticipant's
// grant change alone governs FUTURE publish/renegotiation, not audio
// already in flight. Single attempt, fail-open (review HIGH-2 decision): a
// legitimate timed-out/moderated user staying briefly un-silenced on a
// transient LiveKit hiccup is far less harmful than the unmute leg's
// failure mode below, and GenerateToken's own gate still blocks their NEXT
// reconnect regardless.
//
// muted false (unmute): the identical UpdateParticipant call with
// CanPublish restored to true, no MutePublishedTrack call (LiveKit has no
// publisher-side "un-mute a server-muted track" API — the publishing
// client owns resuming its own track). Bounded retry with backoff, then
// eviction on exhaustion (review HIGH-2 fix): unlike the mute leg, a
// failure here leaves a LEGITIMATE user silenced with no path back — the
// client has no LiveKit ParticipantPermissionsChanged listener (see
// AdminUpdateState's doc comment for the ordering fix this pairs with), so
// there is no client-side retry to lean on. After the retry budget is
// exhausted, removeParticipantFromLiveKit forces a disconnect: the
// client's own reconnect logic requests a fresh token, and GenerateToken
// issues it with the correct (now-unmuted) canPublish — a visible
// connection drop, but strictly better than silent, unrecoverable muting.
//
// Does not touch the "_ss" screen-share sub-participant. Screen-share
// audio (if the client publishes any) travels on that separate identity's
// separate connection, and server-mute's product intent (per
// AdminUpdateState's existing UX/audit event naming — "mute", not
// "silence everything") is specifically the microphone, matching
// useMicSync's own client-side scope. Revisit if screen-share audio ever
// becomes a moderation target in its own right.
func (s *voiceService) applyServerMuteToLiveKit(channelID, userID string) {
	setupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	channel, err := s.channelGetter.GetByID(setupCtx, channelID)
	if err != nil {
		voiceLogger.Error("applyServerMute: channel lookup failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: channel lookup failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	lkInstance, err := s.livekitGetter.GetByServerID(setupCtx, channel.ServerID)
	if err != nil {
		voiceLogger.Error("applyServerMute: livekit instance lookup failed", "server_id", channel.ServerID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: LiveKit instance lookup failed", map[string]string{
			"server_id": channel.ServerID, "channel_id": channelID, "error": err.Error(),
		})
		return
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		voiceLogger.Error("applyServerMute: api key decrypt failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: API key decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		voiceLogger.Error("applyServerMute: api secret decrypt failed", "channel_id", channelID, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: API secret decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	roomName := channel.ServerID + ":" + channelID
	roomClient := lksdk.NewRoomServiceClient(lkInstance.URL, apiKey, apiSecret)

	// Review MEDIUM-1 fix: re-derive truth here (not from a captured
	// parameter) — see this function's own doc comment above.
	muted := s.currentServerMute(userID, channel.ServerID)

	if muted {
		attemptCtx, attemptCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer attemptCancel()
		_ = s.attemptServerMuteUpdate(attemptCtx, roomClient, roomName, channelID, userID, true)
		return
	}

	// Review HIGH-2 fix: unmute is the "a legitimate user goes permanently
	// silent" failure mode — bounded retry with backoff before giving up.
	// serverMuteUnmuteRetryBackoffs (package-level var, not a local
	// literal) so tests can shrink it to avoid a real multi-second sleep —
	// see its own doc comment.
	var lastErr error
	for attempt := 0; ; attempt++ {
		attemptCtx, attemptCancel := context.WithTimeout(context.Background(), 10*time.Second)
		lastErr = s.attemptServerMuteUpdate(attemptCtx, roomClient, roomName, channelID, userID, false)
		attemptCancel()
		if lastErr == nil {
			return
		}
		if attempt >= len(serverMuteUnmuteRetryBackoffs) {
			break
		}
		voiceLogger.Info("applyServerMute: unmute attempt failed, retrying",
			"user_id", userID, "room", roomName, "attempt", attempt+1, "err", pkg.ErrText(lastErr))
		time.Sleep(serverMuteUnmuteRetryBackoffs[attempt])
	}

	// Retries exhausted — force a reconnect rather than leave the user
	// permanently silenced. Distinctive ERROR log + audit-visible
	// logError: this is "our own hardening layer failed its one job," not
	// a routine not_found no-op (those already returned nil inside
	// attemptServerMuteUpdate and never reach here).
	voiceLogger.Error("applyServerMute: unmute failed after retries, evicting to force a reconnect",
		"user_id", userID, "room", roomName, "attempts", len(serverMuteUnmuteRetryBackoffs)+1, "err", pkg.ErrText(lastErr))
	s.logError(models.LogCategoryVoice, &userID, "applyServerMute: unmute failed after retries — evicted participant to force a fresh token", map[string]string{
		"room": roomName, "channel_id": channelID, "error": lastErr.Error(),
	})
	s.removeParticipantFromLiveKit(channelID, userID)
}

// attemptServerMuteUpdate does one GetParticipant + UpdateParticipant (+,
// when muted, MutePublishedTrack) pass, for applyServerMuteToLiveKit's
// unmute retry loop and its own single mute attempt alike. Returns nil for
// both a genuine success AND a "not found" participant (nothing to retry —
// they aren't connected, so there's no live stream to fix; GenerateToken's
// own gate governs their next connect regardless) — only a real
// LiveKit/network error is returned for the caller to retry or exhaust.
func (s *voiceService) attemptServerMuteUpdate(ctx context.Context, roomClient *lksdk.RoomServiceClient, roomName, channelID, userID string, muted bool) error {
	// GetParticipant first: source of truth for (a) the permission fields
	// UpdateParticipant below must not clobber, and (b) — when muting —
	// the track Sid MutePublishedTrack needs, in one round trip instead
	// of two.
	participant, err := roomClient.GetParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     roomName,
		Identity: userID,
	})
	if err != nil {
		meta := map[string]string{"room": roomName, "channel_id": channelID, "error": err.Error(), "muted": fmt.Sprintf("%t", muted)}
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			// Expected whenever the user isn't (yet, or anymore) actually
			// connected to LiveKit. GenerateToken's own server-mute check
			// (voice_token.go) governs their NEXT connect/reconnect; this
			// is purely a live-session hardening layer, so a target that
			// isn't live is a normal no-op, not a failure to retry.
			voiceLogger.Info("applyServerMute: participant not in LiveKit room (not found)", "user_id", userID, "room", roomName)
			s.logInfo(models.LogCategoryVoice, &userID, "applyServerMute: participant not connected to LiveKit", meta)
			return nil
		}
		voiceLogger.Error("applyServerMute: GetParticipant failed", "user_id", userID, "room", roomName, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: GetParticipant failed", meta)
		return err
	}

	perm := buildServerMutePermission(participant.Permission, muted)

	if _, err := roomClient.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:       roomName,
		Identity:   userID,
		Permission: perm,
	}); err != nil {
		meta := map[string]string{"room": roomName, "channel_id": channelID, "error": err.Error(), "muted": fmt.Sprintf("%t", muted)}
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			voiceLogger.Info("applyServerMute: participant already gone (not found)", "user_id", userID, "room", roomName)
			s.logInfo(models.LogCategoryVoice, &userID, "applyServerMute: participant already left LiveKit", meta)
			return nil
		}
		voiceLogger.Error("applyServerMute: UpdateParticipant failed", "user_id", userID, "room", roomName, "err", pkg.ErrText(err))
		s.logError(models.LogCategoryVoice, &userID, "applyServerMute: UpdateParticipant failed", meta)
		return err
	}
	voiceLogger.Info("applyServerMute: updated LiveKit publish grant", "user_id", userID, "room", roomName, "muted", muted)

	if !muted {
		return nil // unmute: no track-level action — see applyServerMuteToLiveKit's doc comment
	}

	// Best-effort: also mute the already-published microphone track
	// directly, so audio already in flight is silenced immediately rather
	// than only on the client's next publish/renegotiation. A failure here
	// does NOT fail the overall attempt — UpdateParticipant above already
	// applied the durable grant change — logged and swallowed, matching
	// the mute leg's fail-open policy.
	for _, track := range participant.Tracks {
		if track.Source != livekit.TrackSource_MICROPHONE {
			continue
		}
		if _, err := roomClient.MutePublishedTrack(ctx, &livekit.MuteRoomTrackRequest{
			Room:     roomName,
			Identity: userID,
			TrackSid: track.Sid,
			Muted:    true,
		}); err != nil {
			voiceLogger.Error("applyServerMute: MutePublishedTrack failed", "user_id", userID, "room", roomName, "track_sid", track.Sid, "err", pkg.ErrText(err))
			s.logError(models.LogCategoryVoice, &userID, "applyServerMute: MutePublishedTrack failed", map[string]string{
				"room": roomName, "channel_id": channelID, "track_sid": track.Sid, "error": err.Error(),
			})
		}
		break // one microphone track expected per participant
	}
	return nil
}

// EnforceModerationOnJoin evicts userID from the LiveKit room for
// (serverID, channelID) if they are currently timed out or banned on
// serverID, and (review MEDIUM-2 fix) re-applies an active server-mute if
// one is in effect. Called from handlers.LiveKitWebhookHandler's
// participant_joined callback (A-29a) — a defense-in-depth backstop, not a
// primary gate: JoinChannel already rejects timed-out/banned users before a
// token is ever requested, and GenerateToken (voice_token.go) already folds
// an active server-mute into canPublish at token-issuance time. This closes
// the residual window a token issued moments before a ban/timeout/mute
// lands stays valid for (voiceTokenTTL, 15min) — LiveKit's webhook fires
// the moment the participant actually connects, independent of when the
// token was minted.
//
// The server-mute case has a second path into this same window besides a
// stale token: a same-server channel switch. IsServerMuted deliberately
// carries into the new channel's in-memory VoiceState (voice_state.go,
// A-38's same-server carry-over decision), but the client reconnects to a
// DIFFERENT LiveKit room for the new channel — applyServerMuteToLiveKit
// (voice_admin.go's AdminUpdateState) already ran against the OLD room at
// mute time and has nothing to do for a participant who isn't connected
// yet, so the new room's connection would otherwise come up with whatever
// canPublish GenerateToken issued for THAT specific request. This is that
// enforcement's other half.
//
// Fail-open on checker/state-read error: logged, not treated as
// "moderated"/muted. The primary gates already fail closed on a genuine
// timeout/ban/mute; a backstop that also evicts or re-mutes on every
// transient DB hiccup would kick or silence innocent participants for
// reasons unrelated to moderation.
func (s *voiceService) EnforceModerationOnJoin(ctx context.Context, serverID, channelID, userID string) {
	moderated := false

	if s.timeoutChecker != nil {
		active, err := s.timeoutChecker.IsActive(ctx, serverID, userID)
		if err != nil {
			voiceLogger.Error("EnforceModerationOnJoin: timeout check failed", "server_id", serverID, "user_id", userID, "err", pkg.ErrText(err))
		} else if active {
			moderated = true
		}
	}

	if !moderated && s.banChecker != nil {
		banned, err := s.banChecker.Exists(ctx, serverID, userID)
		if err != nil {
			voiceLogger.Error("EnforceModerationOnJoin: ban check failed", "server_id", serverID, "user_id", userID, "err", pkg.ErrText(err))
		} else if banned {
			moderated = true
		}
	}

	if moderated {
		voiceLogger.Info("EnforceModerationOnJoin: evicting moderated participant",
			"server_id", serverID, "channel_id", channelID, "user_id", userID)
		// Dual-identity removal (main + "_ss" screen-share sub-participant,
		// if any) — a moderated user's screen share must not keep
		// streaming after their voice session is evicted. See
		// removeParticipantAndScreenShareFromLiveKit's own doc comment for
		// the LiveKit call and error handling.
		go s.removeParticipantAndScreenShareFromLiveKit(channelID, userID)
		return
	}

	// Review MEDIUM-2 fix: not timed out/banned, but still check the
	// in-memory server-mute flag for THIS join. currentServerMute only
	// returns true if the user's current voice state is on serverID and
	// IsServerMuted — i.e. exactly the case this webhook fires for
	// (participant_joined on channelID, which belongs to serverID).
	if s.currentServerMute(userID, serverID) {
		voiceLogger.Info("EnforceModerationOnJoin: re-applying server-mute grant on join",
			"server_id", serverID, "channel_id", channelID, "user_id", userID)
		go s.applyServerMuteToLiveKit(channelID, userID)
	}
}

// StartAFKChecker periodically checks for inactive voice users and kicks them.
// Runs every 30 seconds — checks each user's LastActivity against the server's afk_timeout_minutes.
func (s *voiceService) StartAFKChecker() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepAFKUsers()
		}
	}()
}

// sweepAFKUsers finds and kicks users who exceeded their server's AFK timeout.
// Two-phase: identify AFK users under read lock, then kick outside lock.
func (s *voiceService) sweepAFKUsers() {
	now := time.Now()

	// Phase 1: identify potential AFK users under read lock
	type candidate struct {
		userID    string
		channelID string
		idleSince time.Time
	}
	var candidates []candidate

	s.mu.RLock()
	for userID, state := range s.states {
		// Skip users who are streaming — they're actively sharing content
		if state.IsStreaming {
			continue
		}
		candidates = append(candidates, candidate{
			userID:    userID,
			channelID: state.ChannelID,
			idleSince: state.LastActivity,
		})
	}
	s.mu.RUnlock()

	if len(candidates) == 0 {
		return
	}

	// Phase 2: check each candidate against server AFK timeout (requires DB lookups)
	// Group by channel to minimize DB queries
	channelTimeouts := make(map[string]time.Duration) // channelID -> timeout
	channelInfo := make(map[string]afkEntry)          // channelID -> server/channel names

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var toKick []afkEntry

	for _, c := range candidates {
		timeout, ok := channelTimeouts[c.channelID]
		if !ok {
			channel, err := s.channelGetter.GetByID(ctx, c.channelID)
			if err != nil {
				continue
			}
			server, err := s.afkTimeoutGetter.GetByID(ctx, channel.ServerID)
			if err != nil {
				continue
			}
			timeout = time.Duration(server.AFKTimeoutMinutes) * time.Minute
			channelTimeouts[c.channelID] = timeout
			channelInfo[c.channelID] = afkEntry{
				channelID:   c.channelID,
				channelName: channel.Name,
				serverID:    server.ID,
				serverName:  server.Name,
			}
		}

		if timeout <= 0 {
			continue
		}

		if now.Sub(c.idleSince) >= timeout {
			info := channelInfo[c.channelID]
			toKick = append(toKick, afkEntry{
				userID:      c.userID,
				channelID:   info.channelID,
				channelName: info.channelName,
				serverID:    info.serverID,
				serverName:  info.serverName,
			})
		}
	}

	// Phase 3: kick AFK users
	for _, entry := range toKick {
		voiceLogger.Info("AFK kick: idle too long", "user_id", entry.userID, "channel_id", entry.channelID, "server_id", entry.serverID)

		// Notify user before disconnect
		s.hub.BroadcastToUser(entry.userID, ws.Event{
			Op: ws.OpVoiceAFKKick,
			Data: ws.VoiceAFKKickData{
				ChannelID:   entry.channelID,
				ChannelName: entry.channelName,
				ServerName:  entry.serverName,
			},
		})

		// Use the existing disconnect flow
		s.DisconnectUser(entry.userID)
	}
}
