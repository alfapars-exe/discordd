package main

import (
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// voiceCallbackRegistrar keeps service routing separate from transport state.
type voiceCallbackRegistrar interface {
	OnVoiceJoin(ws.VoiceJoinCallback)
	OnVoiceLeave(ws.VoiceLeaveCallback)
	OnVoiceStateUpdate(ws.VoiceStateUpdateCallback)
	OnVoiceAdminStateUpdate(ws.VoiceAdminStateUpdateCallback)
	OnVoiceMoveUser(ws.VoiceMoveUserCallback)
	OnVoiceDisconnectUser(ws.VoiceDisconnectUserCallback)
	OnScreenShareWatch(ws.ScreenShareWatchCallback)
	OnVoiceActivity(ws.VoiceActivityCallback)
}

func registerVoiceCallbacks(hub voiceCallbackRegistrar, voiceService services.VoiceService,
	userRepo repository.UserRepository, channelRepo repository.ChannelRepository, serverRepo repository.ServerRepository) func() {
	activity := newVoiceActivityWriter(voiceActivityWrite(userRepo, channelRepo, serverRepo))
	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID, isMuted, isDeafened); err != nil {
			hubLogger.Error("voice join failed", "area", "voice", "user_id", userID, "channel_id", channelID, "err", pkg.ErrText(err))
			return
		}

		activity.enqueue(userID, channelID)
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
	return activity.stop
}
