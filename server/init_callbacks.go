package main

import (
	"log"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

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
) {
	// ─── Presence Callbacks ───

	hub.OnUserFirstConnect(userFirstConnectCallback(hub, userRepo))

	hub.OnUserFullyDisconnected(func(userID, _ string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if updateErr := userRepo.UpdateStatus(ctx, userID, models.UserStatusOffline); updateErr != nil {
			log.Printf("[presence] failed to set offline for user %s: %v", userID, updateErr)
		}

		hub.SetInvisible(userID, false)

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOffline),
			},
		})
		log.Printf("[presence] user %s disconnected (DB set to offline)", userID)

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
				log.Printf("[voice] failed to clear streaming on disconnect user=%s: %v", userID, updErr)
			}
		}

		p2pCallService.HandleDisconnect(userID)
	})

	hub.OnPresenceManualUpdate(presenceUpdateCallback(hub, userRepo))

	// ─── Voice Callbacks ───

	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID, isMuted, isDeafened); err != nil {
			log.Printf("[voice] join error user=%s channel=%s: %v", userID, channelID, err)
			return
		}

		// Activity tracking runs after the in-memory join has already taken
		// effect, so it is pure bookkeeping — one bounded budget covers all
		// three writes rather than letting each stall independently.
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		// Track last voice activity for admin panel
		if actErr := userRepo.UpdateLastVoiceActivity(ctx, userID); actErr != nil {
			log.Printf("[voice] failed to update user voice activity user=%s: %v", userID, actErr)
		}

		// Track server-level voice activity
		ch, chErr := channelRepo.GetByID(ctx, channelID)
		if chErr != nil {
			log.Printf("[voice] channel lookup for activity tracking failed channel=%s: %v", channelID, chErr)
			return
		}
		if actErr := serverRepo.UpdateLastVoiceActivity(ctx, ch.ServerID); actErr != nil {
			log.Printf("[voice] failed to update server voice activity server=%s: %v", ch.ServerID, actErr)
		}
	})
	hub.OnVoiceLeave(func(userID string) {
		if err := voiceService.LeaveChannel(userID); err != nil {
			log.Printf("[voice] leave error user=%s: %v", userID, err)
		}
	})
	hub.OnVoiceStateUpdate(func(userID string, isMuted, isDeafened, isStreaming *bool) {
		if err := voiceService.UpdateState(userID, isMuted, isDeafened, isStreaming); err != nil {
			log.Printf("[voice] state update error user=%s: %v", userID, err)
		}
	})
	// The three moderation callbacks below only spend their context on
	// DB-backed permission resolution (services/voice_admin.go) — the LiveKit
	// side effects don't take it — so the broadcast budget fits them exactly.
	hub.OnVoiceAdminStateUpdate(func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.AdminUpdateState(ctx, adminUserID, targetUserID, isServerMuted, isServerDeafened); err != nil {
			log.Printf("[voice] admin state update error admin=%s target=%s: %v", adminUserID, targetUserID, err)
		}
	})
	hub.OnVoiceMoveUser(func(moverUserID, targetUserID, targetChannelID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.MoveUser(ctx, moverUserID, targetUserID, targetChannelID); err != nil {
			log.Printf("[voice] move user error mover=%s target=%s channel=%s: %v", moverUserID, targetUserID, targetChannelID, err)
		}
	})
	hub.OnVoiceDisconnectUser(func(disconnecterUserID, targetUserID string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		if err := voiceService.AdminDisconnectUser(ctx, disconnecterUserID, targetUserID); err != nil {
			log.Printf("[voice] disconnect user error disconnecter=%s target=%s: %v", disconnecterUserID, targetUserID, err)
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
			log.Printf("[p2p] initiate error caller=%s receiver=%s: %v", callerID, data.ReceiverID, err)
		}
	})
	hub.OnP2PCallAccept(func(userID string, data ws.P2PCallAcceptData) {
		if err := p2pCallService.AcceptCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] accept error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallDecline(func(userID string, data ws.P2PCallDeclineData) {
		if err := p2pCallService.DeclineCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] decline error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallEnd(func(userID string) {
		if err := p2pCallService.EndCall(userID); err != nil {
			log.Printf("[p2p] end error user=%s: %v", userID, err)
		}
	})
	hub.OnP2PSignal(func(senderID string, data ws.P2PSignalData) {
		if err := p2pCallService.RelaySignal(senderID, data.CallID, data); err != nil {
			log.Printf("[p2p] signal relay error sender=%s call=%s: %v", senderID, data.CallID, err)
		}
	})

	// ─── Channel Typing Callback ───
	// Validates sender has ReadMessages permission, then broadcasts to server members only.

	hub.OnChannelTyping(func(senderUserID, senderUsername, channelID string) {
		// Typing fires on every keystroke burst; a bounded context keeps a
		// wedged database from pinning WS reader goroutines.
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		ch, chErr := channelRepo.GetByID(ctx, channelID)
		if chErr != nil {
			return
		}

		// Filter recipients to server members who have ViewChannel + ReadMessages
		// on this channel (respects per-channel permission overrides). One bulk
		// resolve — the per-user loop this replaces ran up to 3 queries per
		// online member per typing event.
		onlineUsers := hub.GetOnlineUserIDsForServer(ch.ServerID)
		perms, permErr := channelPermResolver.ResolveChannelPermissionsBulk(ctx, channelID, onlineUsers)
		if permErr != nil {
			log.Printf("[typing] bulk permission resolve failed channel=%s: %v", channelID, permErr)
			return
		}

		recipients := make([]string, 0, len(onlineUsers))
		for _, uid := range onlineUsers {
			if uid == senderUserID {
				continue
			}
			if perms[uid].Has(models.PermViewChannel) && perms[uid].Has(models.PermReadMessages) {
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
	})

	// ─── DM Typing Callback ───

	hub.OnDMTyping(dmTypingCallback(hub, dmRepo))
}

// userFirstConnectCallback resolves a newly-connected user's persisted
// pref_status and publishes the resulting presence.
//
// Both DB calls share one bounded context: they are a single logical unit
// (read the preference, write the derived status), and the point of the bound
// is to cap the goroutine's total lifetime, not each statement's.
func userFirstConnectCallback(hub *ws.Hub, userRepo repository.UserRepository) ws.UserConnectionCallback {
	return func(userID, _ string) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		// Read persistent pref_status from DB (not client-provided — client may differ per device).
		user, err := userRepo.GetByID(ctx, userID)
		if err != nil {
			log.Printf("[presence] failed to get user %s: %v", userID, err)
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
			log.Printf("[presence] user %s connected as invisible (pref_status=offline)", userID)
			return
		}

		if updateErr := userRepo.UpdateStatus(ctx, userID, targetStatus); updateErr != nil {
			log.Printf("[presence] failed to update status for user %s: %v", userID, updateErr)
		}

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(targetStatus),
			},
		})
		log.Printf("[presence] user %s connected with status %s (from pref_status)", userID, targetStatus)
	}
}

// presenceUpdateCallback persists a presence change and fans it out.
// Fires on manual status changes and on auto-idle transitions alike.
func presenceUpdateCallback(hub *ws.Hub, userRepo repository.UserRepository) ws.PresenceManualUpdateCallback {
	return func(userID string, status string, isAuto bool) {
		ctx, cancel := services.BroadcastContext()
		defer cancel()

		st := models.UserStatus(status)

		if err := userRepo.UpdateStatus(ctx, userID, st); err != nil {
			log.Printf("[presence] failed to set %s for user %s: %v", status, userID, err)
			return
		}

		// Only persist pref_status for manual changes — auto-idle should not
		// overwrite the user's preferred status, so idle detection can resume
		// correctly after WS reconnect.
		if !isAuto {
			if err := userRepo.UpdatePrefStatus(ctx, userID, st); err != nil {
				log.Printf("[presence] failed to set pref_status %s for user %s: %v", status, userID, err)
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
		log.Printf("[presence] user %s is now %s (%s)", userID, status, source)
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
