// Package handlers -- LiveKitWebhookHandler receives webhook events from LiveKit servers.
// Events (participant_joined, participant_left, etc.) are logged to app_logs
// for diagnosing voice disconnection issues. The disconnect_reason field on
// participant_left events is the primary diagnostic signal.
//
// Multi-instance: credentials are loaded from DB (all livekit_instances),
// decrypted with AES-256-GCM and attributed to the signed JWT issuer. Room
// callbacks are additionally bound to the instance assigned to that server.
package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/services"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

var webhookLogger = logx.Component("handler.livekit_webhook")

// WebhookKeyLoader loads encrypted LiveKit credentials from DB.
// Returns ALL instances (not just platform-managed) so self-hosted instances
// can also send webhooks.
type WebhookKeyLoader interface {
	ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error)
}

// WebhookServerInstanceResolver resolves the LiveKit instance currently
// assigned to a server. A verified webhook issuer is only authoritative for
// room callbacks when this mapping matches the room's server ID.
type WebhookServerInstanceResolver interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
}

// VoiceModerationEnforcer is the narrow slice of services.VoiceService the
// webhook needs: given a participant_joined event's resolved (serverID,
// channelID, userID), evict the participant if they're currently timed out
// or banned on serverID. See services.voiceService.EnforceModerationOnJoin
// (voice_lifecycle.go) for the implementation and the A-29a rationale.
type VoiceModerationEnforcer interface {
	EnforceModerationOnJoin(ctx context.Context, serverID, channelID, userID string)
}

type LiveKitWebhookHandler struct {
	keyLoader      WebhookKeyLoader
	serverResolver WebhookServerInstanceResolver
	encryptionKey  []byte // AES-256-GCM key for credential decryption
	appLogger      services.AppLogService
	voiceEnforcer  VoiceModerationEnforcer
	streamNotifier services.StreamStartNotifier
}

func NewLiveKitWebhookHandler(keyLoader WebhookKeyLoader, encryptionKey []byte, appLogger services.AppLogService, voiceEnforcer VoiceModerationEnforcer, serverResolvers ...WebhookServerInstanceResolver) *LiveKitWebhookHandler {
	h := &LiveKitWebhookHandler{
		keyLoader:     keyLoader,
		encryptionKey: encryptionKey,
		appLogger:     appLogger,
		voiceEnforcer: voiceEnforcer,
	}
	if len(serverResolvers) > 0 {
		h.serverResolver = serverResolvers[0]
	}
	return h
}

// SetStreamStartNotifier wires the provider-verified stream notification path.
// A nil notifier disables notifications; webhook signature and room binding
// verification remain mandatory regardless.
func (h *LiveKitWebhookHandler) SetStreamStartNotifier(notifier services.StreamStartNotifier) {
	if h != nil {
		h.streamNotifier = notifier
	}
}

// HandleWebhook — POST /api/livekit/webhook
// No auth middleware — LiveKit signs the request with HMAC, verified via webhook.ReceiveWebhookEvent.
func (h *LiveKitWebhookHandler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	// Reject oversized bodies early — legitimate webhook payloads are <10KB
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

	provider, err := h.buildKeyProvider(r.Context())
	if err != nil {
		webhookLogger.Error("failed to load keys", "err", pkg.ErrText(err))
		// LiveKit's webhook sender only inspects the status code, not the
		// body, so the JSON envelope is safe here too — kept consistent
		// with the rest of the API instead of a bare http.Error.
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "internal error")
		return
	}

	// The issuer is untrusted until ReceiveWebhookEvent verifies its signature.
	// Parsing it first lets the verifier select exactly one instance credential
	// instead of accepting a valid key and losing which instance signed it.
	parsedToken, err := auth.ParseAPIToken(r.Header.Get("Authorization"))
	if err != nil || parsedToken == nil || parsedToken.APIKey() == "" {
		webhookLogger.Warn("verification failed: invalid issuer token")
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	issuerInstanceID, issuerOK := provider.instanceIDFor(parsedToken.APIKey())
	if !issuerOK {
		webhookLogger.Warn("verification failed: unknown or ambiguous issuer")
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	event, err := webhook.ReceiveWebhookEvent(r, provider)
	if err != nil {
		webhookLogger.Error("verification failed", "err", pkg.ErrText(err))
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if webhookEventHasRoomAuthority(event) {
		if err := h.verifyRoomInstance(r.Context(), event, issuerInstanceID); err != nil {
			webhookLogger.Warn("rejected webhook room-instance binding", "err", pkg.ErrText(err))
			if err == errWebhookInstanceResolverUnavailable || err == errWebhookRoomBindingLookup {
				pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "temporarily unavailable")
			} else {
				pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
			}
			return
		}
	}
	if event.GetEvent() == "track_published" && h.streamNotifier != nil {
		if err := h.notifyScreenShareStart(r.Context(), event, issuerInstanceID); err != nil {
			webhookLogger.Error("failed to process stream start notification", "err", pkg.ErrText(err))
			pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "temporarily unavailable")
			return
		}
	}

	h.logEvent(r.Context(), event)

	w.WriteHeader(http.StatusOK)
}

func (h *LiveKitWebhookHandler) notifyScreenShareStart(ctx context.Context, event *livekit.WebhookEvent, issuerInstanceID string) error {
	track := event.GetTrack()
	participant := event.GetParticipant()
	room := event.GetRoom()
	if track == nil || participant == nil || room == nil || track.GetSid() == "" ||
		track.GetType() != livekit.TrackType_VIDEO || track.GetSource() != livekit.TrackSource_SCREEN_SHARE {
		return nil
	}
	identity := participant.GetIdentity()
	actorID := identity
	if strings.HasSuffix(identity, "_ss") {
		actorID = strings.TrimSuffix(identity, "_ss")
	}
	if actorID == "" || strings.HasSuffix(actorID, "_ss") {
		return nil
	}
	serverID, channelID, ok := strings.Cut(room.GetName(), ":")
	if !ok || serverID == "" || channelID == "" || strings.Contains(channelID, ":") {
		return errWebhookRoomMalformed
	}
	publicationTime := time.Unix(event.GetCreatedAt(), 0).UTC()
	if !services.IsFreshStreamPublication(publicationTime, time.Now().UTC()) {
		return nil
	}
	return h.streamNotifier.NotifyStreamStart(ctx, issuerInstanceID, serverID, channelID, actorID, room.GetName(), track.GetSid(), publicationTime)
}

// webhookInstanceKeyProvider exposes only unambiguous credentials and retains
// their owning instance ID for the post-verification room binding check.
type webhookInstanceKeyProvider struct {
	credentials map[string]webhookInstanceCredential
	ambiguous   map[string]struct{}
}

type webhookInstanceCredential struct {
	instanceID string
	secret     string
}

func (p *webhookInstanceKeyProvider) GetSecret(key string) string {
	if _, ambiguous := p.ambiguous[key]; ambiguous {
		return ""
	}
	return p.credentials[key].secret
}

func (p *webhookInstanceKeyProvider) NumKeys() int { return len(p.credentials) }

func (p *webhookInstanceKeyProvider) instanceIDFor(key string) (string, bool) {
	if _, ambiguous := p.ambiguous[key]; ambiguous {
		return "", false
	}
	credential, ok := p.credentials[key]
	return credential.instanceID, ok && credential.instanceID != "" && credential.secret != ""
}

// buildKeyProvider loads credentials for all configured instances. Reused API
// keys are removed from the verifier: such a key cannot be safely attributed
// to one instance, so room-scoped callbacks must fail closed.
func (h *LiveKitWebhookHandler) buildKeyProvider(ctx context.Context) (*webhookInstanceKeyProvider, error) {
	instances, err := h.keyLoader.ListAllInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}

	provider := &webhookInstanceKeyProvider{
		credentials: make(map[string]webhookInstanceCredential, len(instances)),
		ambiguous:   make(map[string]struct{}),
	}
	seenAPIKeys := make(map[string]struct{}, len(instances))
	for _, inst := range instances {
		apiKey, err := crypto.Decrypt(inst.APIKey, h.encryptionKey)
		if err != nil {
			webhookLogger.Error("failed to decrypt key for instance", "instance_id", inst.ID, "err", pkg.ErrText(err))
			continue
		}
		if _, duplicate := seenAPIKeys[apiKey]; duplicate {
			delete(provider.credentials, apiKey)
			provider.ambiguous[apiKey] = struct{}{}
			continue
		}
		seenAPIKeys[apiKey] = struct{}{}
		apiSecret, err := crypto.Decrypt(inst.APISecret, h.encryptionKey)
		if err != nil {
			webhookLogger.Error("failed to decrypt secret for instance", "instance_id", inst.ID, "err", pkg.ErrText(err))
			continue
		}
		provider.credentials[apiKey] = webhookInstanceCredential{instanceID: inst.ID, secret: apiSecret}
	}

	if len(provider.credentials) == 0 && len(provider.ambiguous) == 0 {
		return nil, fmt.Errorf("no LiveKit instances with valid credentials found")
	}

	return provider, nil
}

var (
	errWebhookInstanceResolverUnavailable = errors.New("webhook server-instance resolver unavailable")
	errWebhookRoomBindingLookup           = errors.New("webhook room binding lookup failed")
	errWebhookRoomInstanceMismatch        = errors.New("webhook room instance mismatch")
	errWebhookRoomMalformed               = errors.New("webhook room name malformed")
)

func webhookEventHasRoomAuthority(event *livekit.WebhookEvent) bool {
	if event == nil {
		return false
	}
	switch event.GetEvent() {
	case "participant_joined", "participant_left", "track_published", "track_unpublished":
		return true
	default:
		return false
	}
}

func (h *LiveKitWebhookHandler) verifyRoomInstance(ctx context.Context, event *livekit.WebhookEvent, issuerInstanceID string) error {
	room := event.GetRoom()
	if room == nil {
		return errWebhookRoomMalformed
	}
	serverID, channelID, ok := strings.Cut(room.GetName(), ":")
	if !ok || serverID == "" || channelID == "" || strings.Contains(channelID, ":") || issuerInstanceID == "" {
		return errWebhookRoomMalformed
	}
	if h.serverResolver == nil {
		return errWebhookInstanceResolverUnavailable
	}
	instance, err := h.serverResolver.GetByServerID(ctx, serverID)
	if err != nil {
		return errWebhookRoomBindingLookup
	}
	if instance == nil || instance.ID != issuerInstanceID {
		return errWebhookRoomInstanceMismatch
	}
	return nil
}

// logEvent writes relevant webhook events to app_logs, and on
// participant_joined also runs the A-29a moderation backstop (see
// enforceModerationOnJoin). Only participant events are logged — room/track/
// egress events are noisy and less useful.
func (h *LiveKitWebhookHandler) logEvent(ctx context.Context, event *livekit.WebhookEvent) {
	eventType := event.GetEvent()

	switch eventType {
	case "participant_joined", "participant_left":
		// continue
	default:
		return
	}

	participant := event.GetParticipant()
	room := event.GetRoom()
	if participant == nil {
		return
	}

	identity := participant.GetIdentity()
	roomName := ""
	if room != nil {
		roomName = room.GetName()
	}

	ts := time.Unix(event.GetCreatedAt(), 0).UTC().Format("15:04:05")

	metadata := map[string]string{
		"livekit_event": eventType,
		"room":          roomName,
		"identity":      identity,
		"timestamp":     ts,
	}

	level := models.LogLevelInfo
	message := ""

	switch eventType {
	case "participant_joined":
		message = fmt.Sprintf("participant joined room %s", roomName)
		h.enforceModerationOnJoin(ctx, roomName, identity)

	case "participant_left":
		reason := participant.GetDisconnectReason().String()
		metadata["disconnect_reason"] = reason
		message = fmt.Sprintf("participant left room %s (reason: %s)", roomName, reason)

		if participant.GetDisconnectReason() != livekit.DisconnectReason_CLIENT_INITIATED {
			level = models.LogLevelWarn
		}
	}

	userID := identity
	h.appLogger.Log(ctx, level, models.LogCategoryLiveKit, &userID, nil, message, metadata)
}

// enforceModerationOnJoin parses roomName (always "{serverID}:{channelID}",
// see voice_token.go GenerateToken) and forwards the resolved IDs to
// voiceEnforcer so an already timed-out or banned user gets evicted the
// moment LiveKit reports them as connected — closing the residual
// voiceTokenTTL (15min) reconnect window a ban/timeout applied just after
// token issuance would otherwise leave open. A screen-share sub-participant
// identity carries a "_ss" suffix (voice_token.go GenerateScreenShareToken)
// that isn't part of the real user id the timeout/ban repos key on, so it
// is stripped before the check and before the eviction call — voiceEnforcer
// (services.voiceService.EnforceModerationOnJoin) evicts BOTH the stripped
// userID's main voice connection and its "_ss" screen-share sub-participant
// (if any), so a moderated user's screen share doesn't keep streaming to
// the room after their voice connection is gone.
//
// Best-effort: an unrecognized room name (should never happen — every room
// this server issues a token for uses this format) or a nil voiceEnforcer
// (not wired) just skips silently. This whole path is a backstop, not the
// primary authorization gate.
func (h *LiveKitWebhookHandler) enforceModerationOnJoin(ctx context.Context, roomName, identity string) {
	if h.voiceEnforcer == nil {
		return
	}
	serverID, channelID, ok := strings.Cut(roomName, ":")
	if !ok || serverID == "" || channelID == "" {
		webhookLogger.Error("enforceModerationOnJoin: unparseable room name", "room", roomName)
		return
	}
	userID := strings.TrimSuffix(identity, "_ss")
	h.voiceEnforcer.EnforceModerationOnJoin(ctx, serverID, channelID, userID)
}
