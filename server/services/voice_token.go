// Package services — voice token generation.
// LiveKit JWT token creation for voice join and screen share sub-participants.
package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
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

func (s *voiceService) GenerateToken(ctx context.Context, userID, username, displayName, serverID, channelID string) (*models.VoiceTokenResponse, error) {
	var channel *models.Channel
	var admission *models.VoiceAdmission
	var lkInstance *models.LiveKitInstance
	var used int64
	var err error
	now := time.Now()
	if reader := s.voiceAccess; reader != nil {
		admission, lkInstance, used, err = reader.VoiceTokenAccess(ctx, userID, channelID, now)
		if err == nil {
			channel = &admission.Channel
		}
		pkg.MarkVoiceTime(ctx, "token_lookup")
	} else {
		channel, admission, err = s.loadVoiceChannel(ctx, userID, channelID)
		pkg.MarkVoiceTime(ctx, "admission")
	}
	if err != nil {
		return nil, err
	}
	if channel.ServerID != serverID || serverID == "" {
		return nil, fmt.Errorf("%w: channel outside requested server", pkg.ErrForbidden)
	}
	if admission == nil {
		member, lookupErr := s.afkTimeoutGetter.IsMember(ctx, serverID, userID)
		if lookupErr != nil {
			return nil, lookupErr
		}
		if !member {
			return nil, fmt.Errorf("%w: not a member of this server", pkg.ErrForbidden)
		}
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// Timeout gate — matches the Send-Message check in messageService.
	// Token issuance is the right boundary: without a token the LiveKit
	// SDK can't connect, so timed-out users physically can't talk even
	// if their UI somehow leaks past the client-side gate. Nil checker
	// is fine (tests + bootstrap paths that haven't wired it yet).
	if admission != nil {
		if err := validateVoiceAdmission(admission); err != nil {
			return nil, err
		}
	} else if s.timeoutChecker != nil && channel.ServerID != "" {
		active, tErr := s.timeoutChecker.IsActive(ctx, channel.ServerID, userID)
		if tErr != nil {
			return nil, fmt.Errorf("check timeout: %w", tErr)
		}
		if active {
			return nil, fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	// channel -> server -> livekit_instance lookup, migrating to a fresh
	// instance first if this one is nearing its monthly quota.
	if lkInstance == nil {
		lkInstance, err = s.ensureLiveKitInstance(ctx, userID, channel.ServerID)
		if err != nil {
			return nil, err
		}
	} else if lkInstance.IsPlatformManaged && lkInstance.AutoSwitchEnabled {
		lkInstance = s.selectVoiceInstance(ctx, channel.ServerID, lkInstance, now, used)
	}

	apiKey, apiSecret, err := s.liveKitCredentials(userID, lkInstance)
	if err != nil {
		return nil, err
	}

	// Resolve effective permissions (role base + channel overrides)
	var effectivePerms models.Permission
	if admission != nil {
		effectivePerms = admission.Permissions
	} else {
		effectivePerms, err = s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	}
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
			voiceLogger.Info("force-move grant consumed", "user_id", userID, "channel_id", channelID)
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

	response, err := s.issueVoiceToken(voiceTokenIssue{
		userID: userID, username: username, displayName: displayName,
		serverID: channel.ServerID, channelID: channelID,
		url: lkInstance.URL, apiKey: apiKey, apiSecret: apiSecret,
		permissions: effectivePerms,
	})
	if err != nil {
		return nil, err
	}

	pkg.MarkVoiceTime(ctx, "issue")
	return response, nil
}

// liveKitCredentials decrypts the instance's API key pair for local JWT
// signing. Shared by GenerateToken and MoveUser's embedded credentials
// (moveCredentials, voice_admin.go).
func (s *voiceService) liveKitCredentials(userID string, lkInstance *models.LiveKitInstance) (apiKey, apiSecret string, err error) {
	apiKey, err = crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit API key decryption failed", map[string]string{
			"instance_id": lkInstance.ID, "error": pkg.ErrText(err),
		})
		return "", "", fmt.Errorf("failed to decrypt livekit api key: %w", err)
	}
	apiSecret, err = crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit API secret decryption failed", map[string]string{
			"instance_id": lkInstance.ID, "error": pkg.ErrText(err),
		})
		return "", "", fmt.Errorf("failed to decrypt livekit api secret: %w", err)
	}
	return apiKey, apiSecret, nil
}

// voiceTokenIssue is what issueVoiceToken needs once admission has been
// decided by its caller.
type voiceTokenIssue struct {
	userID, username, displayName string
	serverID, channelID           string
	url, apiKey, apiSecret        string
	permissions                   models.Permission
}

// issueVoiceToken is the "issue" half of token generation: publish grant,
// JWT signing and the room's media key. It performs NO admission check and
// no database access — membership, timeout, ConnectVoice (or the force-move
// placement) and the user limit are the caller's responsibility. Callers:
// GenerateToken (HTTP token request) and moveCredentials (voice_admin.go).
// It takes s.mu itself (currentServerMute, roomMediaKey), so it must never
// be called with the lock held.
func (s *voiceService) issueVoiceToken(issue voiceTokenIssue) (*models.VoiceTokenResponse, error) {
	// Server-mute (AdminUpdateState, voice_admin.go) is folded into the
	// LiveKit publish grant itself, not just PermSpeak — previously a
	// server-muted user still got canPublish=true here as long as they had
	// PermSpeak, so the sanction was purely a client-side advisory
	// (useMicSync); a modified client could ignore it and keep publishing
	// audio. currentServerMute reads the live in-memory voice state
	// (voice_state.go — see its own doc comment for why "no state" safely
	// defaults to "not muted"), scoped to this channel's SERVER since the
	// sanction is server-wide, not channel-specific. Deafen deliberately
	// does NOT affect canSubscribe here: deafen is a local listening
	// preference the user themselves controls, not something a moderator
	// enforces — blocking subscription would silently break the user's own
	// ability to un-deafen and hear again.
	sources := voicePublishSources(issue.permissions, s.currentServerMute(issue.userID, issue.serverID))
	canPublish := len(sources) > 0
	canSubscribe := true
	canPublishData := true

	at := auth.NewAccessToken(issue.apiKey, issue.apiSecret)

	// Room name = "{serverID}:{channelID}" to avoid collisions across servers
	roomName := issue.serverID + ":" + issue.channelID

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	grant.SetCanPublishSources(sources)
	participantName := issue.username
	if issue.displayName != "" {
		participantName = issue.displayName
	}

	// TTL controlled by voiceTokenTTL (15min as of 2026-05-27 audit).
	// See voiceTokenTTL declaration for rationale.
	at.SetVideoGrant(grant).
		SetIdentity(issue.userID).
		SetName(participantName).
		SetValidFor(voiceTokenTTL)

	token, err := at.ToJWT()
	if err != nil {
		s.logError(models.LogCategoryVoice, &issue.userID, "LiveKit JWT generation failed", map[string]string{
			"channel_id": issue.channelID, "error": pkg.ErrText(err),
		})
		return nil, fmt.Errorf("failed to generate livekit token: %w", err)
	}

	// E2EE: per-room SFrame passphrase (created on first join, reused for session)
	passphrase, epoch, keyContext, err := s.roomMediaKey(roomName)
	if err != nil {
		return nil, fmt.Errorf("failed to create E2EE passphrase: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:          token,
		URL:            issue.url,
		ChannelID:      issue.channelID,
		E2EEPassphrase: passphrase,
		E2EEKeyIndex:   epoch % 256,
		E2EEKeyEpoch:   uint64(epoch),
		E2EEKeyContext: keyContext,
	}, nil
}

// ensureLiveKitInstance resolves the LiveKit instance for serverID and, if it
// is a platform-managed cloud instance nearing its monthly quota, migrates
// the server to the next eligible instance before returning it. Extracted
// from GenerateToken so the auto-switch side effect has exactly one call
// site instead of being inlined into token generation.
//
// Self-hosted instances (IsPlatformManaged=false) skip the auto-switch
// check entirely; they have no quota and aren't part of the rotation.
//
// Auto-switch rule: if (used + threshold*60) >= quota*60, look for the next
// eligible cloud instance (lower priority wins, same threshold check
// applied) and migrate the server's livekit_instance_id atomically.
// Fail-open: any error in the check or migration leaves the server on its
// current instance — voice still works, it just keeps burning the original
// budget.
func (s *voiceService) ensureLiveKitInstance(ctx context.Context, userID, serverID string) (*models.LiveKitInstance, error) {
	lkInstance, err := s.livekitGetter.GetByServerID(ctx, serverID)
	pkg.MarkVoiceTime(ctx, "instance")
	if err != nil {
		s.logError(models.LogCategoryVoice, &userID, "LiveKit instance lookup failed", map[string]string{
			"server_id": serverID, "error": pkg.ErrText(err),
		})
		return nil, fmt.Errorf("failed to get livekit instance for server %s: %w", serverID, err)
	}

	if lkInstance.IsPlatformManaged && lkInstance.AutoSwitchEnabled {
		now := time.Now()
		year, month, _ := now.Date()
		used, usageErr := s.livekitGetter.GetMonthlyUsage(ctx, lkInstance.ID, year, int(month))
		pkg.MarkVoiceTime(ctx, "quota")
		if usageErr == nil {
			lkInstance = s.selectVoiceInstance(ctx, serverID, lkInstance, now, used)
		}
	}

	return lkInstance, nil
}

func (s *voiceService) selectVoiceInstance(ctx context.Context, serverID string, lkInstance *models.LiveKitInstance, now time.Time, used int64) *models.LiveKitInstance {
	year, month := now.Year(), now.Month()
	thresholdSec := int64(lkInstance.SwitchThresholdMinutes) * 60
	quotaSec := int64(lkInstance.MonthlyQuotaMinutes) * 60
	if liveKitInstanceNearQuota(lkInstance, used) {
		next, nextErr := s.livekitGetter.GetNextAutoSwitchInstance(ctx, lkInstance.ID, year, int(month))
		if nextErr == nil && next != nil {
			if migErr := s.livekitGetter.MigrateOneServer(ctx, serverID, next.ID); migErr == nil {
				voiceLogger.Info("auto-switch LiveKit instance",
					"server_id", serverID, "from_instance", lkInstance.ID, "to_instance", next.ID,
					"used_seconds", used, "quota_seconds", quotaSec, "threshold_seconds", thresholdSec)
				lkInstance = next
			} else {
				voiceLogger.Error("auto-switch migrate failed", "server_id", serverID, "err", pkg.ErrText(migErr))
			}
		}
		// nextErr or next==nil: no eligible target — stay put.
	}
	return lkInstance
}

// liveKitInstanceNearQuota is the auto-switch rule documented on
// ensureLiveKitInstance: used seconds are inside the instance's switch
// threshold of its monthly quota.
func liveKitInstanceNearQuota(lkInstance *models.LiveKitInstance, used int64) bool {
	return used+int64(lkInstance.SwitchThresholdMinutes)*60 >= int64(lkInstance.MonthlyQuotaMinutes)*60
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

	// Timeout gate — same rationale as GenerateToken above: a timed-out user
	// must not be able to pick up a screen share sub-participant token either.
	if s.timeoutChecker != nil && channel.ServerID != "" {
		active, tErr := s.timeoutChecker.IsActive(ctx, channel.ServerID, userID)
		if tErr != nil {
			return nil, fmt.Errorf("check timeout: %w", tErr)
		}
		if active {
			return nil, fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	// User must already be in this voice channel to screen share.
	// state.ChannelID is read here, still under the lock — reading it after
	// RUnlock (as this used to) is a data race: state is a *models.VoiceState
	// pointer shared with the map, and another goroutine (e.g. JoinChannel)
	// can concurrently write its fields the instant the lock is released.
	s.mu.RLock()
	state, inVoice := s.states[userID]
	inChannel := inVoice && state.ChannelID == channelID
	s.mu.RUnlock()
	if !inChannel {
		return nil, fmt.Errorf("%w: must be in the voice channel to screen share", pkg.ErrBadRequest)
	}
	perms, err := s.currentVoicePermissions(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !perms.Has(models.PermStream) {
		return nil, fmt.Errorf("%w: stream permission required", pkg.ErrForbidden)
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
	grant.SetCanPublishSources([]livekit.TrackSource{livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO})

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

	passphrase, epoch, keyContext, err := s.roomMediaKey(roomName)
	if err != nil {
		return nil, fmt.Errorf("failed to create E2EE passphrase: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:          token,
		URL:            lkInstance.URL,
		ChannelID:      channelID,
		E2EEPassphrase: passphrase,
		E2EEKeyIndex:   epoch % 256,
		E2EEKeyEpoch:   uint64(epoch),
		E2EEKeyContext: keyContext,
	}, nil
}

func (s *voiceService) loadVoiceChannel(ctx context.Context, userID, channelID string) (*models.Channel, *models.VoiceAdmission, error) {
	if repo := s.voiceAccess; repo != nil {
		a, err := repo.VoiceAdmission(ctx, userID, channelID)
		if err != nil {
			return nil, nil, err
		}
		return &a.Channel, a, nil
	}
	ch, err := s.channelGetter.GetByID(ctx, channelID)
	return ch, nil, err
}

// voiceJoinAccess is what JoinChannel reads from the database before it
// touches the voice state.
type voiceJoinAccess struct {
	channel   *models.Channel
	admission *models.VoiceAdmission // nil on the portable path: authorizeJoin decides
	// instanceResolved: the access read already settled the server's LiveKit
	// instance (snapshot path), so JoinChannel must not look it up again.
	// instance is nil, with instanceErr set, when the server has none linked.
	instanceResolved bool
	instance         *models.LiveKitInstance
	instanceErr      error
}

// loadVoiceJoin is JoinChannel's database read. With a snapshot reader the
// channel, the admission facts and the server's LiveKit instance come from
// one statement — the token read — instead of an admission read followed by
// a separate instance lookup. The instance is only reported, for quota
// attribution on the voice state: unlike GenerateToken, a join never selects
// or migrates one.
//
// The token read joins the server's LiveKit instance, so pkg.ErrNotFound is
// also what a channel on a server with no instance linked looks like. A join
// has never required one (the session just goes unattributed), so that case
// repeats the plain admission read; only that read's own pkg.ErrNotFound
// means the channel is gone. Any other error is returned as it is — a failed
// snapshot never falls back.
func (s *voiceService) loadVoiceJoin(ctx context.Context, userID, channelID string) (voiceJoinAccess, error) {
	reader := s.voiceAccess
	if reader == nil {
		channel, admission, err := s.loadVoiceChannel(ctx, userID, channelID)
		return voiceJoinAccess{channel: channel, admission: admission}, err
	}
	admission, instance, _, err := reader.VoiceTokenAccess(ctx, userID, channelID, time.Now())
	if errors.Is(err, pkg.ErrNotFound) {
		channel, admission, admissionErr := s.loadVoiceChannel(ctx, userID, channelID)
		return voiceJoinAccess{channel: channel, admission: admission, instanceResolved: true, instanceErr: err}, admissionErr
	}
	if err != nil {
		return voiceJoinAccess{}, err
	}
	return voiceJoinAccess{channel: &admission.Channel, admission: admission, instanceResolved: true, instance: instance}, nil
}

func validateVoiceAdmission(a *models.VoiceAdmission) error {
	if a.Channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}
	if !a.Member {
		return fmt.Errorf("%w: not a member of this server", pkg.ErrForbidden)
	}
	if a.TimedOut {
		return fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
	}
	return nil
}

func voicePublishSources(perms models.Permission, muted bool) []livekit.TrackSource {
	if muted {
		return nil
	}
	var sources []livekit.TrackSource
	if perms.Has(models.PermSpeak) {
		sources = append(sources, livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA)
	}
	if perms.Has(models.PermStream) {
		sources = append(sources, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	}
	return sources
}

func (s *voiceService) currentVoicePermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	if fresh := s.freshPermissions; fresh != nil {
		return fresh.ResolveChannelPermissionsFresh(ctx, userID, channelID)
	}
	return s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
}
