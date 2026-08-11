// Package handlers -- LiveKitWebhookHandler receives webhook events from LiveKit servers.
// Events (participant_joined, participant_left, etc.) are logged to app_logs
// for diagnosing voice disconnection issues. The disconnect_reason field on
// participant_left events is the primary diagnostic signal.
//
// Multi-instance: key/secret pairs are loaded from DB (all livekit_instances),
// decrypted with AES-256-GCM, then used to build a multi-key HMAC verifier.
package handlers

import (
	"context"
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

// VoiceModerationEnforcer is the narrow slice of services.VoiceService the
// webhook needs: given a participant_joined event's resolved (serverID,
// channelID, userID), evict the participant if they're currently timed out
// or banned on serverID. See services.voiceService.EnforceModerationOnJoin
// (voice_lifecycle.go) for the implementation and the A-29a rationale.
type VoiceModerationEnforcer interface {
	EnforceModerationOnJoin(ctx context.Context, serverID, channelID, userID string)
}

type LiveKitWebhookHandler struct {
	keyLoader     WebhookKeyLoader
	encryptionKey []byte // AES-256-GCM key for credential decryption
	appLogger     services.AppLogService
	voiceEnforcer VoiceModerationEnforcer
}

func NewLiveKitWebhookHandler(keyLoader WebhookKeyLoader, encryptionKey []byte, appLogger services.AppLogService, voiceEnforcer VoiceModerationEnforcer) *LiveKitWebhookHandler {
	return &LiveKitWebhookHandler{
		keyLoader:     keyLoader,
		encryptionKey: encryptionKey,
		appLogger:     appLogger,
		voiceEnforcer: voiceEnforcer,
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

	event, err := webhook.ReceiveWebhookEvent(r, provider)
	if err != nil {
		webhookLogger.Error("verification failed", "err", pkg.ErrText(err))
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	h.logEvent(r.Context(), event)

	w.WriteHeader(http.StatusOK)
}

// buildKeyProvider loads all LiveKit instance credentials from DB, decrypts them,
// and builds a multi-key provider. Webhook from any known instance verifies.
func (h *LiveKitWebhookHandler) buildKeyProvider(ctx context.Context) (auth.KeyProvider, error) {
	instances, err := h.keyLoader.ListAllInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}

	keys := make(map[string]string, len(instances))
	for _, inst := range instances {
		apiKey, err := crypto.Decrypt(inst.APIKey, h.encryptionKey)
		if err != nil {
			webhookLogger.Error("failed to decrypt key for instance", "instance_id", inst.ID, "err", pkg.ErrText(err))
			continue
		}
		apiSecret, err := crypto.Decrypt(inst.APISecret, h.encryptionKey)
		if err != nil {
			webhookLogger.Error("failed to decrypt secret for instance", "instance_id", inst.ID, "err", pkg.ErrText(err))
			continue
		}
		keys[apiKey] = apiSecret
	}

	if len(keys) == 0 {
		return nil, fmt.Errorf("no LiveKit instances with valid credentials found")
	}

	return auth.NewFileBasedKeyProviderFromMap(keys), nil
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
	h.appLogger.Log(level, models.LogCategoryLiveKit, &userID, nil, message, metadata)
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
