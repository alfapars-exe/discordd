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

		s.cleanupRoomPassphraseIfEmpty(channelID)
		orphans = append(orphans, orphanEntry{
			userID:            userID,
			channelID:         channelID,
			joinedAt:          joinedAt,
			livekitInstanceID: instanceID,
			livekitIsCloud:    isCloud,
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

// EnforceModerationOnJoin evicts userID from the LiveKit room for
// (serverID, channelID) if they are currently timed out or banned on
// serverID. Called from handlers.LiveKitWebhookHandler's participant_joined
// callback (A-29a) — a defense-in-depth backstop, not a primary gate:
// GenerateToken/JoinChannel (voice_token.go/voice_state.go) already reject
// timed-out/banned users before a token is ever issued. This closes the
// residual window a token issued moments before a ban/timeout lands stays
// valid for (voiceTokenTTL, 15min) — LiveKit's webhook fires the moment the
// participant actually connects, independent of when the token was minted.
//
// Fail-open on checker error: logged, not treated as "moderated". The
// primary gates already fail closed on a genuine timeout/ban; a backstop
// that also evicts on every transient DB hiccup would kick innocent
// participants off a live call for reasons unrelated to moderation.
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

	if !moderated {
		return
	}

	voiceLogger.Info("EnforceModerationOnJoin: evicting moderated participant",
		"server_id", serverID, "channel_id", channelID, "user_id", userID)
	// Dual-identity removal (main + "_ss" screen-share sub-participant, if
	// any) — a moderated user's screen share must not keep streaming after
	// their voice session is evicted. See
	// removeParticipantAndScreenShareFromLiveKit's own doc comment for the
	// LiveKit call and error handling.
	go s.removeParticipantAndScreenShareFromLiveKit(channelID, userID)
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
