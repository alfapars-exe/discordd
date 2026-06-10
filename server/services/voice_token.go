// Package services — voice token generation.
// LiveKit JWT token creation for voice join and screen share sub-participants.
package services

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"

	"github.com/livekit/protocol/auth"
)

// voiceTokenTTL caps how long a single LiveKit JWT remains valid.
//
// Audit 2026-05-27 (P1-BC-06): reduced from 1h → 15min. Moderation actions
// (kick, ban, timeout) take effect only when the user's next token request
// is denied — with a 1h token a banned user could keep talking for up to
// 60 minutes. 15min strikes the balance: ban → max 15min residual access,
// while a single talkative voice session triggers ~4 token refreshes/hour
// (well below LiveKit's stated capacity).
//
// For instant revocation, pair this with webhook-driven ejection on
// ban/kick events (see livekit_webhook.go) — the TTL is just the
// fail-safe floor.
const voiceTokenTTL = 15 * time.Minute

func (s *voiceService) GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error) {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// Timeout gate — matches the Send-Message check in messageService.
	// Token issuance is the right boundary: without a token the LiveKit
	// SDK can't connect, so timed-out users physically can't talk even
	// if their UI somehow leaks past the client-side gate. Nil checker
	// is fine (tests + bootstrap paths that haven't wired it yet).
	if s.timeoutChecker != nil && channel.ServerID != "" {
		active, tErr := s.timeoutChecker.IsActive(ctx, channel.ServerID, userID)
		if tErr != nil {
			return nil, fmt.Errorf("check timeout: %w", tErr)
		}
		if active {
			return nil, fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	// channel -> server -> livekit_instance lookup
	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit instance lookup failed", map[string]string{
			"server_id": channel.ServerID, "error": err.Error(),
		})
		return nil, fmt.Errorf("failed to get livekit instance for server %s: %w", channel.ServerID, err)
	}

	// ─── Auto-switch when this cloud instance is running out of monthly quota.
	// Self-hosted instances (IsPlatformManaged=false) skip this entirely; they
	// have no quota and aren't part of the rotation.
	//
	// Rule: if (used + threshold*60) >= quota*60, look for the next eligible
	// cloud instance (lower priority wins, same threshold check applied), and
	// migrate the server's livekit_instance_id atomically. Fail-open: any
	// error stays on the current instance — voice still works, we just keep
	// burning the original budget.
	if lkInstance.IsPlatformManaged && lkInstance.AutoSwitchEnabled {
		now := time.Now()
		year, month, _ := now.Date()
		used, usageErr := s.livekitGetter.GetMonthlyUsage(ctx, lkInstance.ID, year, int(month))
		if usageErr == nil {
			thresholdSec := int64(lkInstance.SwitchThresholdMinutes) * 60
			quotaSec := int64(lkInstance.MonthlyQuotaMinutes) * 60
			if used+thresholdSec >= quotaSec {
				next, nextErr := s.livekitGetter.GetNextAutoSwitchInstance(ctx, lkInstance.ID, year, int(month))
				if nextErr == nil && next != nil {
					if migErr := s.livekitGetter.MigrateOneServer(ctx, channel.ServerID, next.ID); migErr == nil {
						log.Printf("[voice] auto-switch server=%s from instance=%s to instance=%s (used=%ds quota=%ds threshold=%ds)",
							channel.ServerID, lkInstance.ID, next.ID, used, quotaSec, thresholdSec)
						lkInstance = next
					} else {
						log.Printf("[voice] auto-switch migrate failed server=%s err=%v", channel.ServerID, migErr)
					}
				}
				// nextErr or next==nil: no eligible target — stay put.
			}
		}
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit API key decryption failed", map[string]string{
			"instance_id": lkInstance.ID, "error": err.Error(),
		})
		return nil, fmt.Errorf("failed to decrypt livekit api key: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit API secret decryption failed", map[string]string{
			"instance_id": lkInstance.ID, "error": err.Error(),
		})
		return nil, fmt.Errorf("failed to decrypt livekit api secret: %w", err)
	}

	// Resolve effective permissions (role base + channel overrides)
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}

	if !effectivePerms.Has(models.PermConnectVoice) {
		// Check for a one-time force-move grant (admin moved this user here)
		s.mu.Lock()
		grant, hasGrant := s.forceMoveGrants[userID]
		if hasGrant && grant.channelID == channelID && time.Now().Before(grant.expiresAt) {
			delete(s.forceMoveGrants, userID) // consume — single use only
			s.mu.Unlock()
			log.Printf("[voice] force-move grant consumed for user %s in channel %s", userID, channelID)
		} else {
			if hasGrant {
				delete(s.forceMoveGrants, userID) // expired or wrong channel — clean up
			}
			s.mu.Unlock()
			return nil, fmt.Errorf("%w: missing voice connect permission", pkg.ErrForbidden)
		}
	}

	// User limit check (0 = unlimited)
	if channel.UserLimit > 0 {
		participants := s.GetChannelParticipants(channelID)
		alreadyIn := false
		for _, p := range participants {
			if p.UserID == userID {
				alreadyIn = true
				break
			}
		}
		if !alreadyIn && len(participants) >= channel.UserLimit {
			return nil, fmt.Errorf("%w: voice channel is full", pkg.ErrBadRequest)
		}
	}

	canPublish := effectivePerms.Has(models.PermSpeak)
	canSubscribe := true
	canPublishData := true

	at := auth.NewAccessToken(apiKey, apiSecret)

	// Room name = "{serverID}:{channelID}" to avoid collisions across servers
	roomName := channel.ServerID + ":" + channelID

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	participantName := username
	if displayName != "" {
		participantName = displayName
	}

	// TTL controlled by voiceTokenTTL (15min as of 2026-05-27 audit).
	// See voiceTokenTTL declaration for rationale.
	at.SetVideoGrant(grant).
		SetIdentity(userID).
		SetName(participantName).
		SetValidFor(voiceTokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit JWT generation failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return nil, fmt.Errorf("failed to generate livekit token: %w", err)
	}

	// E2EE: per-room SFrame passphrase (created on first join, reused for session)
	passphrase, err := s.getOrCreateRoomPassphrase(roomName)
	if err != nil {
		return nil, fmt.Errorf("failed to create E2EE passphrase: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:          token,
		URL:            lkInstance.URL,
		ChannelID:      channelID,
		E2EEPassphrase: passphrase,
	}, nil
}

// GenerateScreenShareToken generates a LiveKit token for the iOS native screen share connection.
// The identity is "{userID}_ss" so it joins the same room as a separate participant
// that only publishes the screen share track. The main JS SDK connection stays active for voice.
func (s *voiceService) GenerateScreenShareToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error) {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// User must already be in this voice channel to screen share
	s.mu.RLock()
	state, inVoice := s.states[userID]
	s.mu.RUnlock()
	if !inVoice || state.ChannelID != channelID {
		return nil, fmt.Errorf("%w: must be in the voice channel to screen share", pkg.ErrBadRequest)
	}

	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance for server %s: %w", channel.ServerID, err)
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api key: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api secret: %w", err)
	}

	canPublish := true
	canSubscribe := false   // screen share participant doesn't need to subscribe
	canPublishData := false // no data channel needed

	at := auth.NewAccessToken(apiKey, apiSecret)

	roomName := channel.ServerID + ":" + channelID

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	// Identity suffix "_ss" marks this as a screen share sub-participant
	ssIdentity := userID + "_ss"
	participantName := username + " (Screen)"
	if displayName != "" {
		participantName = displayName + " (Screen)"
	}

	// Screen share token TTL matches voice token TTL (15min as of 2026-05-27
	// audit) — long screen shares trigger ~4 refreshes/hour, but a stolen
	// token can't outlive a moderation event by more than the TTL window.
	at.SetVideoGrant(grant).
		SetIdentity(ssIdentity).
		SetName(participantName).
		SetValidFor(voiceTokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		return nil, fmt.Errorf("failed to generate screen share token: %w", err)
	}

	passphrase, err := s.getOrCreateRoomPassphrase(roomName)
	if err != nil {
		return nil, fmt.Errorf("failed to create E2EE passphrase: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:          token,
		URL:            lkInstance.URL,
		ChannelID:      channelID,
		E2EEPassphrase: passphrase,
	}, nil
}
