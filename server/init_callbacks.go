package main

import (
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// hubLogger tags every Hub-callback log line (presence/voice/p2p/typing
// event handling wired below) so they can be filtered separately from the
// boot-sequence logs in main.go/bootstrap.go/init_services.go.
var hubLogger = logx.Component("server")

// registerHubCallbacks wires Hub events to service layer logic.
//
// Every callback below runs on its own goroutine. Presence callbacks are
// launched with `go` by Hub.addClient / Hub.removeClient (ws/hub_clients.go),
// and the voice / typing / DM callbacks with `go` by the owning client's read
// pump (ws/client_voice.go, ws/client_presence.go). That is what keeps the
// mutex discipline safe — a callback may re-enter the Hub to broadcast while
// add/removeClient still holds the write lock.
//
// It is also what makes the bounded contexts below safe *and* necessary:
// blocking in a callback can never stall the Hub's Run loop or a read pump,
// but it does pin one goroutine per event. These callbacks have no request
// context to inherit, so an unbounded context.Background() against a stalled
// remote database would pin that goroutine forever — a reconnect storm then
// leaks a goroutine per event with nothing to reap them. Each DB-touching
// callback therefore derives its context from services.BroadcastContext()
// (5s, deliberately just above the DB busy_timeout of 5000ms so a legitimate
// lock wait is not cancelled a moment before it would have succeeded).
//
// The callbacks that do this work are extracted into named constructors
// below rather than written inline, because the Hub stores callbacks in
// unexported fields — a test cannot retrieve them after registration, so
// they have to be constructible on their own to be testable.
func registerHubCallbacks(
	hub *ws.Hub,
	userRepo repository.UserRepository,
	dmRepo repository.DMRepository,
	voiceService services.VoiceService,
	p2pCallService services.P2PCallService,
	channelRepo repository.ChannelRepository,
	serverRepo repository.ServerRepository,
	channelPermResolver services.ChannelPermResolver,
) (stopPresenceDebounce func()) {
	// presenceDebouncer delays the OFFLINE presence transition (DB write +
	// broadcast) by presenceOfflineGrace so a brief reconnect never flaps
	// every client's presence list. See presence_debounce.go's doc comment
	// for the root cause and grace-period rationale. One instance shared
	// between the disconnect callback (schedules) and the first-connect
	// callback (cancels on reconnect).
	presenceDebouncer := newPresenceOfflineDebouncer(presenceOfflineGrace)

	// ─── Presence Callbacks ───

	hub.OnUserFirstConnect(userFirstConnectCallback(hub, userRepo, presenceDebouncer))

	hub.OnUserFullyDisconnected(userFullyDisconnectedCallback(hub, userRepo, voiceService, p2pCallService, presenceDebouncer))

	hub.OnPresenceManualUpdate(presenceUpdateCallback(hub, userRepo))

	// ─── Voice Callbacks ───

	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID, isMuted, isDeafened); err != nil {
			hubLogger.Error("voice join failed", "area", "voice", "user_id", userID, "channel_id", channelID, "err", pkg.ErrText(err))
			return
		}

		// Activity tracking runs after the in-memory join has already taken
		// effect, so it is pure bookkeeping — one bounded budget covers all
		// three writes rather than letting each stall independently.
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		// Track last voice activity for admin panel
		if actErr := userRepo.UpdateLastVoiceActivity(ctx, userID); actErr != nil {
			hubLogger.Error("failed to update user voice activity", "area", "voice", "user_id", userID, "err", pkg.ErrText(actErr))
		}

		// Track server-level voice activity
		ch, chErr := channelRepo.GetByID(ctx, channelID)
		if chErr != nil {
			hubLogger.Error("channel lookup for activity tracking failed", "area", "voice", "channel_id", channelID, "err", pkg.ErrText(chErr))
			return
		}
		if actErr := serverRepo.UpdateLastVoiceActivity(ctx, ch.ServerID); actErr != nil {
			hubLogger.Error("failed to update server voice activity", "area", "voice", "server_id", ch.ServerID, "err", pkg.ErrText(actErr))
		}
	})
	hub.OnVoiceLeave(func(userID string) {
		if err := voiceService.LeaveChannel(userID); err != nil {
			hubLogger.Error("voice leave failed", "area", "voice", "user_id", userID, "err", pkg.ErrText(err))
		}
	})
	hub.OnVoiceStateUpdate(func(userID string, isMuted, isDeafened, isStreaming *bool) {
		if err := voiceService.UpdateState(userID, isMuted, isDeafened, isStreaming); err != nil {
			hubLogger.Error("voice state update failed", "area", "voice", "user_id", userID, "err", pkg.ErrText(err))
		}
	})
	// The three moderation callbacks below only spend their context on
	// DB-backed permission resolution (services/voice_admin.go) — the LiveKit
	// side effects don't take it — so the broadcast budget fits them exactly.
	hub.OnVoiceAdminStateUpdate(func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.AdminUpdateState(ctx, adminUserID, targetUserID, isServerMuted, isServerDeafened); err != nil {
			hubLogger.Error("voice admin state update failed", "area", "voice", "admin_user_id", adminUserID, "target_user_id", targetUserID, "err", pkg.ErrText(err))
		}
	})
	hub.OnVoiceMoveUser(func(moverUserID, targetUserID, targetChannelID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.MoveUser(ctx, moverUserID, targetUserID, targetChannelID); err != nil {
			hubLogger.Error("voice move user failed", "area", "voice", "mover_user_id", moverUserID, "target_user_id", targetUserID, "channel_id", targetChannelID, "err", pkg.ErrText(err))
		}
	})
	hub.OnVoiceDisconnectUser(func(disconnecterUserID, targetUserID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.AdminDisconnectUser(ctx, disconnecterUserID, targetUserID); err != nil {
			hubLogger.Error("voice admin disconnect user failed", "area", "voice", "disconnecter_user_id", disconnecterUserID, "target_user_id", targetUserID, "err", pkg.ErrText(err))
		}
	})
	hub.OnScreenShareWatch(func(viewerUserID, streamerUserID string, watching bool) {
		voiceService.WatchScreenShare(viewerUserID, streamerUserID, watching)
	})
	hub.OnVoiceActivity(func(userID string) {
		voiceService.UpdateActivity(userID)
	})

	// ─── P2P Call Callbacks ───

	hub.OnP2PCallInitiate(func(callerID string, data ws.P2PCallInitiateData) {
		callType := models.P2PCallType(data.CallType)
		if err := p2pCallService.InitiateCall(callerID, data.ReceiverID, callType); err != nil {
			hubLogger.Error("p2p call initiate failed", "area", "p2p", "caller_id", callerID, "receiver_id", data.ReceiverID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallAccept(func(userID string, data ws.P2PCallAcceptData) {
		if err := p2pCallService.AcceptCall(userID, data.CallID); err != nil {
			hubLogger.Error("p2p call accept failed", "area", "p2p", "user_id", userID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallDecline(func(userID string, data ws.P2PCallDeclineData) {
		if err := p2pCallService.DeclineCall(userID, data.CallID); err != nil {
			hubLogger.Error("p2p call decline failed", "area", "p2p", "user_id", userID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallEnd(func(userID string) {
		if err := p2pCallService.EndCall(userID); err != nil {
			hubLogger.Error("p2p call end failed", "area", "p2p", "user_id", userID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PSignal(func(senderID string, data ws.P2PSignalData) {
		if err := p2pCallService.RelaySignal(senderID, data.CallID, data); err != nil {
			hubLogger.Error("p2p signal relay failed", "area", "p2p", "sender_id", senderID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})

	// ─── Channel Typing Callback ───
	// Validates BOTH the sender and each recipient have ReadMessages
	// permission, then broadcasts to server members only.

	hub.OnChannelTyping(channelTypingCallback(hub, channelRepo, channelPermResolver))

	// ─── DM Typing Callback ───

	hub.OnDMTyping(dmTypingCallback(hub, dmRepo))

	return presenceDebouncer.stopAll
}

// userFirstConnectCallback resolves a newly-connected user's persisted
// pref_status and publishes the resulting presence.
//
// Both DB calls share one bounded context: they are a single logical unit
// (read the preference, write the derived status), and the point of the bound
// is to cap the goroutine's total lifetime, not each statement's.
//
// hub is typed as the ws.EventPublisher interface (rather than the concrete
// *ws.Hub, matching channelTypingCallback's rationale) so tests can
// substitute testutil.MockEventPublisher and observe the presence broadcast
// directly — needed for the presence-offline debounce tests in
// presence_debounce_test.go, which assert on both this callback and
// userFullyDisconnectedCallback sharing one debouncer instance.
func userFirstConnectCallback(hub ws.EventPublisher, userRepo repository.UserRepository, debouncer *presenceOfflineDebouncer) ws.UserConnectionCallback {
	return func(userID, _ string) {
		// A fresh first-connection this soon after the user's last
		// connection fully closed means they reconnected within
		// presenceOfflineGrace (see presence_debounce.go) rather than
		// actually leaving — cancel the pending OFFLINE transition before
		// it fires. No-op (returns false) when nothing is pending, which is
		// the common case (a genuinely new session, not a reconnect).
		debouncer.cancel(userID)

		ctx, cancel := services.BroadcastContext()
		defer cancel()

		// Read persistent pref_status from DB (not client-provided — client may differ per device).
		user, err := userRepo.GetByID(ctx, userID)
		if err != nil {
			hubLogger.Error("failed to get user for first-connect presence", "area", "presence", "user_id", userID, "err", pkg.ErrText(err))
			return
		}

		targetStatus := user.PrefStatus
		if targetStatus == "" {
			targetStatus = models.UserStatusOnline
		}

		if targetStatus == models.UserStatusOffline {
			// Invisible — SetInvisible already called in handler.
			hub.BroadcastToAll(ws.Event{
				Op: ws.OpPresence,
				Data: ws.PresenceData{
					UserID: userID,
					Status: string(models.UserStatusOffline),
				},
			})
			hubLogger.Info("user connected as invisible (pref_status=offline)", "area", "presence", "user_id", userID)
			return
		}

		if updateErr := userRepo.UpdateStatus(ctx, userID, targetStatus); updateErr != nil {
			hubLogger.Error("failed to update status on first connect", "area", "presence", "user_id", userID, "err", pkg.ErrText(updateErr))
		}

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(targetStatus),
			},
		})
		hubLogger.Info("user connected with status from pref_status", "area", "presence", "user_id", userID, "status", targetStatus)
	}
}

// userFullyDisconnectedCallback builds the OnUserFullyDisconnected handler.
//
// The OFFLINE presence transition (DB write + broadcast) is NOT run
// synchronously here — it is handed to presenceDebouncer, which delays it by
// presenceOfflineGrace so a reconnect within that window (handled by
// userFirstConnectCallback's debouncer.cancel call) suppresses it entirely.
// See presence_debounce.go's doc comment for the root cause this fixes.
//
// The voice/P2P cleanup below stays synchronous and un-debounced — deliberately
// unchanged from the pre-fix behavior. Both are tied to the WS connection
// itself (the publishing browser tab, the live P2P signaling channel), not to
// presence, and a reconnect re-asserts voice state explicitly
// (voice_state_update_request) rather than relying on stale server-side state
// surviving the grace window.
func userFullyDisconnectedCallback(
	hub ws.EventPublisher,
	userRepo repository.UserRepository,
	voiceService services.VoiceService,
	p2pCallService services.P2PCallService,
	debouncer *presenceOfflineDebouncer,
) ws.UserConnectionCallback {
	return func(userID, _ string) {
		// Invisibility is cleared SYNCHRONOUSLY, not inside the debounced
		// transition (review 2026-08-13, MEDIUM): ws/handler.go sets
		// SetInvisible(true) BEFORE `register <- client`, so a reconnecting
		// invisible user exists in invisibleUsers while still absent from
		// h.clients. A debounced fire in that handshake window would pass
		// the GetOnlineUserIDs recheck and wipe the just-set flag for the
		// rest of the session. Here, at real disconnect time, the user has
		// just left h.clients and no reconnect handshake can predate us.
		hub.SetInvisible(userID, false)

		scheduleOfflinePresenceTransition(debouncer, hub, userRepo, userID)

		// Voice state is NOT cleaned here — WS disconnect != voice leave.
		// LiveKit connection is separate; WS may reconnect shortly.
		// Cleaned by explicit voice_leave or orphan cleanup sweep.

		// is_streaming, however, IS cleared on full disconnect: the screen
		// share publisher and the WS share the same browser tab, so when
		// the WS dies the publishing track is gone too. Leaving the flag
		// stale for the 35 s orphan grace gave viewers a "Ramses is
		// streaming" indicator with no track to back it — UI would flip
		// to compact strip mode showing only a blank video area. If the
		// user reconnects within grace and is still publishing locally,
		// the client re-asserts via voice_state_update_request on the new
		// WS.
		if vState := voiceService.GetUserVoiceState(userID); vState != nil && vState.IsStreaming {
			falseVal := false
			if updErr := voiceService.UpdateState(userID, nil, nil, &falseVal); updErr != nil {
				hubLogger.Error("failed to clear streaming on disconnect", "area", "voice", "user_id", userID, "err", pkg.ErrText(updErr))
			}
		}

		p2pCallService.HandleDisconnect(userID)
	}
}

// scheduleOfflinePresenceTransition hands the OFFLINE DB write + broadcast
// for userID to debouncer, to run after presenceOfflineGrace has elapsed
// with no reconnect. Split out from userFullyDisconnectedCallback so the
// debounce interaction (schedule → cancel-on-reconnect → fire-time recheck)
// is testable without constructing the voice/P2P service dependencies that
// function ALSO drives synchronously (see presence_debounce_test.go).
func scheduleOfflinePresenceTransition(debouncer *presenceOfflineDebouncer, hub ws.EventPublisher, userRepo repository.UserRepository, userID string) {
	debouncer.schedule(userID, func(gen uint64) {
		offlinePresenceTransition(hub, userRepo, debouncer, userID, gen)
	})
}

// offlinePresenceTransition performs the actual OFFLINE DB write + broadcast
// once presenceOfflineDebouncer's grace period has elapsed with no reconnect.
//
// Re-checks hub.GetOnlineUserIDs() first as a belt-and-braces guard against
// this fire racing a reconnect that, for whatever reason, didn't reach
// debouncer.cancel() first — schedule() and cancel() serialize on the
// debouncer's own mutex, so in the normal path cancel() always wins if the
// reconnect happened before the timer fired; this is defense-in-depth, not
// the primary mechanism.
func offlinePresenceTransition(hub ws.EventPublisher, userRepo repository.UserRepository, debouncer *presenceOfflineDebouncer, userID string, gen uint64) {
	for _, connectedID := range hub.GetOnlineUserIDs() {
		if connectedID == userID {
			return
		}
	}

	// Generation gate right before the DB write: a reconnect's cancel()
	// bumps the generation under the debouncer mutex, so an in-flight fire
	// that lost the race aborts here instead of writing OFFLINE over the
	// reconnect's ONLINE (review 2026-08-13, LOW).
	if !debouncer.current(userID, gen) {
		return
	}

	ctx, cancel := services.BroadcastContext()
	defer cancel()

	if updateErr := userRepo.UpdateStatus(ctx, userID, models.UserStatusOffline); updateErr != nil {
		if errors.Is(updateErr, pkg.ErrNotFound) {
			// Expected after a hard delete: the row is gone by the time the
			// grace elapses. Not an operational error.
			hubLogger.Info("offline transition skipped: user row gone (hard delete)", "area", "presence", "user_id", userID)
		} else {
			hubLogger.Error("failed to set offline status", "area", "presence", "user_id", userID, "err", pkg.ErrText(updateErr))
		}
	}

	// Post-write staleness check: a reconnect that landed DURING the write
	// may have had its ONLINE write overwritten by ours. Compensate by
	// re-asserting ONLINE and skip the offline broadcast — the reconnect's
	// own broadcast carries the correct state.
	if !debouncer.current(userID, gen) {
		if compErr := userRepo.UpdateStatus(ctx, userID, models.UserStatusOnline); compErr != nil && !errors.Is(compErr, pkg.ErrNotFound) {
			hubLogger.Error("failed to re-assert online after offline/reconnect race", "area", "presence", "user_id", userID, "err", pkg.ErrText(compErr))
		}
		return
	}

	hub.BroadcastToAll(ws.Event{
		Op: ws.OpPresence,
		Data: ws.PresenceData{
			UserID: userID,
			Status: string(models.UserStatusOffline),
		},
	})
	hubLogger.Info("user disconnected, DB set to offline", "area", "presence", "user_id", userID, "grace", presenceOfflineGrace.String())
}

// presenceUpdateCallback persists a presence change and fans it out.
// Fires on manual status changes and on auto-idle transitions alike.
func presenceUpdateCallback(hub *ws.Hub, userRepo repository.UserRepository) ws.PresenceManualUpdateCallback {
	return func(userID string, status string, isAuto bool) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		st := models.UserStatus(status)

		if err := userRepo.UpdateStatus(ctx, userID, st); err != nil {
			hubLogger.Error("failed to set status", "area", "presence", "status", status, "user_id", userID, "err", pkg.ErrText(err))
			return
		}

		// Only persist pref_status for manual changes — auto-idle should not
		// overwrite the user's preferred status, so idle detection can resume
		// correctly after WS reconnect.
		if !isAuto {
			if err := userRepo.UpdatePrefStatus(ctx, userID, st); err != nil {
				hubLogger.Error("failed to set pref_status", "area", "presence", "status", status, "user_id", userID, "err", pkg.ErrText(err))
			}
		}

		hub.SetInvisible(userID, status == string(models.UserStatusOffline))

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: status,
			},
		})

		source := "manual"
		if isAuto {
			source = "auto"
		}
		hubLogger.Info("presence updated", "area", "presence", "user_id", userID, "status", status, "source", source)
	}
}

// channelTypingCallback validates the SENDER can read the channel before
// broadcasting, then filters recipients to server members who can also read
// it (respects per-channel permission overrides). Extracted into a named
// constructor (see this file's top doc comment) so it can be tested without
// going through the Hub's unexported callback field.
//
// Previously only recipients were filtered — the sender was never checked,
// so any authenticated WS client could forge a typing_start for a channel it
// has no read access to (ws/client_presence.go's handleTyping doc comment
// claimed this was already validated; it wasn't). Fixed here.
//
// hub is typed as the narrow ws.BroadcastAndOnline interface (Broadcaster +
// UserStateProvider — exactly the two capabilities this callback uses)
// rather than the concrete *ws.Hub, so a test can substitute
// testutil.MockEventPublisher and observe both the online-user query and
// the broadcast call directly.
func channelTypingCallback(hub ws.BroadcastAndOnline, channelRepo repository.ChannelRepository, channelPermResolver services.ChannelPermResolver) ws.ChannelTypingCallback {
	return func(senderUserID, senderUsername, channelID string) {
		// Typing fires on every keystroke burst; a bounded context keeps a
		// wedged database from pinning WS reader goroutines.
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		ch, chErr := channelRepo.GetByID(ctx, channelID)
		if chErr != nil {
			return
		}

		// One bulk resolve covers the recipient filter (a per-user loop ran up
		// to 3 queries per online member per typing event). The sender is
		// almost always already in this online-user set too — reuse the bulk
		// answer for them instead of a second, redundant query.
		onlineUsers := hub.GetOnlineUserIDsForServer(ch.ServerID)
		perms, permErr := channelPermResolver.ResolveChannelPermissionsBulk(ctx, channelID, onlineUsers)
		if permErr != nil {
			hubLogger.Error("typing bulk permission resolve failed", "area", "typing", "channel_id", channelID, "err", pkg.ErrText(permErr))
			return
		}

		senderPerms, senderInBulk := perms[senderUserID]
		if !senderInBulk {
			// Sender wasn't in the server's online-user set this callback saw
			// (e.g. a race between the bulk snapshot and this event firing) —
			// resolve individually rather than silently trusting an unchecked
			// sender.
			var senderErr error
			senderPerms, senderErr = channelPermResolver.ResolveChannelPermissions(ctx, senderUserID, channelID)
			if senderErr != nil {
				hubLogger.Error("typing sender permission resolve failed", "area", "typing", "channel_id", channelID, "user_id", senderUserID, "err", pkg.ErrText(senderErr))
				return
			}
		}
		if !models.PermCanReadChannel(senderPerms) {
			return
		}

		recipients := make([]string, 0, len(onlineUsers))
		for _, uid := range onlineUsers {
			if uid == senderUserID {
				continue
			}
			if models.PermCanReadChannel(perms[uid]) {
				recipients = append(recipients, uid)
			}
		}

		hub.BroadcastToUsers(recipients, ws.Event{
			Op: ws.OpTypingStart,
			Data: ws.TypingStartData{
				UserID:    senderUserID,
				Username:  senderUsername,
				ChannelID: channelID,
			},
		})
	}
}

// dmTypingCallback relays a DM typing indicator to the conversation's other
// member. Fires on every keystroke burst, so the channel lookup is bounded —
// an unbounded one would let a wedged DB accumulate goroutines fast.
func dmTypingCallback(hub *ws.Hub, dmRepo repository.DMRepository) ws.DMTypingCallback {
	return func(senderUserID, senderUsername, dmChannelID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		channel, err := dmRepo.GetChannelByID(ctx, dmChannelID)
		if err != nil {
			return
		}
		if channel.User1ID != senderUserID && channel.User2ID != senderUserID {
			return
		}
		otherUserID := channel.User1ID
		if otherUserID == senderUserID {
			otherUserID = channel.User2ID
		}
		hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMTypingStart,
			Data: ws.DMTypingStartData{
				UserID:      senderUserID,
				Username:    senderUsername,
				DMChannelID: dmChannelID,
			},
		})
	}
}
