package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// DMHandler handles DM endpoints.
// messageLimiter is the DM-message budget — its OWN instance, deliberately
// not shared with MessageHandler, so DM traffic and channel traffic can't
// starve each other's allowance. uploadLimiter is a separate per-user cap
// that only fires on multipart requests (20/min); text-only DMs don't touch it.
type DMHandler struct {
	dmService       services.DMService
	dmUploadService services.DMUploadService
	maxUploadSize   int64
	messageLimiter  *ratelimit.MessageRateLimiter
	uploadLimiter   *ratelimit.MessageRateLimiter
}

func NewDMHandler(
	dmService services.DMService,
	dmUploadService services.DMUploadService,
	maxUploadSize int64,
	messageLimiter *ratelimit.MessageRateLimiter,
	uploadLimiter *ratelimit.MessageRateLimiter,
) *DMHandler {
	return &DMHandler{
		dmService:       dmService,
		dmUploadService: dmUploadService,
		maxUploadSize:   maxUploadSize,
		messageLimiter:  messageLimiter,
		uploadLimiter:   uploadLimiter,
	}
}

type createDMChannelRequest struct {
	UserID string `json:"user_id"`
}

// ListChannels handles GET /api/dms
func (h *DMHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channels, err := h.dmService.ListChannels(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channels)
}

// MarkRead handles POST /api/dms/{channelId}/read
// Body is optional: {"message_id": "<id>"} moves the watermark, an empty
// body (or empty message_id) only clears the unread counter. A body that is
// present but not JSON is still a 400.
func (h *DMHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.MarkDMReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var messageID *string
	if id := strings.TrimSpace(req.MessageID); id != "" {
		messageID = &id
	}

	if err := h.dmService.MarkRead(r.Context(), user.ID, channelID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "marked as read"})
}

func (h *DMHandler) MarkUnread(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	var req models.MarkDMReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.MessageID) == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "message_id is required")
		return
	}
	count, err := h.dmService.MarkUnreadFrom(r.Context(), user.ID, channelID, strings.TrimSpace(req.MessageID))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]int{"unread_count": count})
}

// CreateOrGetChannel handles POST /api/dms
// Finds or creates a DM channel between two users.
func (h *DMHandler) CreateOrGetChannel(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req createDMChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.UserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	channel, err := h.dmService.GetOrCreateChannel(r.Context(), user.ID, req.UserID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// AcceptRequest handles POST /api/dms/{channelId}/accept
func (h *DMHandler) AcceptRequest(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.AcceptRequest(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeclineRequest handles POST /api/dms/{channelId}/decline
func (h *DMHandler) DeclineRequest(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.DeclineRequest(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetOrCreateSelfChannel handles POST /api/dms/self (no body): the caller's
// "notes to self" channel, created on first call. The generic POST /api/dms
// keeps rejecting user_id == me; this is the only entry point for it.
func (h *DMHandler) GetOrCreateSelfChannel(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channel, err := h.dmService.GetOrCreateSelfChannel(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// GetMessages handles GET /api/dms/{channelId}/messages?before=&limit=
// (or ?around= / ?after= — see parseHistoryCursor in message.go).
func (h *DMHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	cursor, ok := parseHistoryCursor(w, r.URL.Query())
	if !ok {
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		// Upper bound alongside the existing lower bound so an unbounded
		// ?limit= can't request an arbitrarily large page (matches the
		// clamp already applied elsewhere in this file, e.g. SearchMessages).
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	var page *models.DMMessagePage
	var err error
	switch {
	case cursor.around != "":
		page, err = h.dmService.GetMessagesAround(r.Context(), user.ID, channelID, cursor.around, limit)
	case cursor.after != "":
		page, err = h.dmService.GetMessagesAfter(r.Context(), user.ID, channelID, cursor.after, limit)
	default:
		page, err = h.dmService.GetMessages(r.Context(), user.ID, channelID, cursor.before, limit)
	}
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// SendMessage handles POST /api/dms/{channelId}/messages
// Accepts JSON or multipart/form-data. Files uploaded after message creation, then WS broadcast.
func (h *DMHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	h.sendMessage(w, r, false)
}

func (h *DMHandler) SendIdempotentMessage(w http.ResponseWriter, r *http.Request) {
	h.sendMessage(w, r, true)
}

func (h *DMHandler) SendCapabilities(w http.ResponseWriter, r *http.Request) {
	pkg.JSON(w, http.StatusOK, map[string]any{"text_idempotency_version": 1, "multipart_idempotency_version": 1})
}

func (h *DMHandler) GetEvents(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, 401, "user not found in context")
		return
	}
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil || after < 0 {
		pkg.ErrorWithMessage(w, 400, "valid after cursor required")
		return
	}
	service, ok := h.dmService.(services.DMEventReplayService)
	if !ok {
		pkg.ErrorWithMessage(w, 404, "DM events unavailable")
		return
	}
	page, err := service.GetDMEvents(r.Context(), user.ID, r.PathValue("channelId"), after)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, page)
}

func (h *DMHandler) sendMessage(w http.ResponseWriter, r *http.Request, requireReceipt bool) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.messageLimiter != nil && !h.messageLimiter.Allow(user.ID) {
		retryAfter := h.messageLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many messages, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	contentType := r.Header.Get("Content-Type")

	// Upload-specific throttle (T3.5) — same rationale as message.go: message
	// limiter stops text-burst spam, upload limiter stops sustained
	// storage/bandwidth abuse. Only fires on multipart.
	if isMultipart(contentType) && h.uploadLimiter != nil && !h.uploadLimiter.Allow(user.ID) {
		retryAfter := h.uploadLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many uploads, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	req, ok := h.parseDMSend(w, r)
	if !ok {
		return
	}
	// The legacy multipart endpoint ignored this form field. Keep that contract;
	// only the advertised dedicated endpoint stages atomic idempotent uploads.
	if !requireReceipt && isMultipart(contentType) {
		req.ClientMessageID = ""
	}

	if requireReceipt && !models.ValidGroupSendRequestID(req.ClientMessageID) {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "client_message_id is required")
		return
	}
	var stagedCleanup func()
	if requireReceipt && isMultipart(contentType) {
		var err error
		stagedCleanup, err = h.stageDMSendFiles(r, user.ID, channelID, req)
		if err != nil {
			pkg.Error(w, err)
			return
		}
		defer stagedCleanup()
	}
	msg, err := h.dmService.SendMessage(r.Context(), user.ID, channelID, req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	var uploadFailures []dmUploadFailure
	if !requireReceipt {
		uploadFailures = h.uploadDMSendFiles(r, msg, req.EncryptionVersion == 1)
	}

	// Broadcast after uploads so clients see attachments
	if err := h.finishDMSend(r, msg); err != nil {
		pkg.Error(w, err)
		return
	}

	if len(uploadFailures) > 0 {
		pkg.JSON(w, http.StatusMultiStatus, map[string]any{
			"message":         msg,
			"upload_failures": uploadFailures,
		})
		return
	}

	pkg.JSON(w, http.StatusCreated, msg)
}

// EditMessage handles PATCH /api/dms/messages/{id} (owner only).
func (h *DMHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateDMMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	msg, err := h.dmService.EditMessage(r.Context(), user.ID, messageID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, msg)
}

// DeleteMessage handles DELETE /api/dms/messages/{id} (owner only).
func (h *DMHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if service, ok := h.dmService.(services.DMDeletionReceiptService); ok {
		receipt, err := service.DeleteMessageWithReceipt(r.Context(), user.ID, messageID)
		if err != nil {
			pkg.Error(w, err)
			return
		}
		pkg.JSON(w, http.StatusOK, receipt)
		return
	}
	if err := h.dmService.DeleteMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}

// ─── Reaction Endpoints ───

// ToggleReaction handles POST /api/dms/messages/{id}/reactions
func (h *DMHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ToggleDMReactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		// err.Error() never reaches the client here: models.Validate() returns
		// a fixed, non-request-derived message (CWE-209 hardening), so the
		// response carries a static literal + the VALIDATION_FAILED code
		// instead of the raw error text.
		pkg.ErrorWithCode(w, http.StatusBadRequest, "emoji is required", "VALIDATION_FAILED")
		return
	}

	if err := h.dmService.ToggleReaction(r.Context(), user.ID, messageID, req.Emoji); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ─── Pin Endpoints ───

// PinMessage handles POST /api/dms/messages/{id}/pin
func (h *DMHandler) PinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.PinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "pinned"})
}

// UnpinMessage handles DELETE /api/dms/messages/{id}/pin
func (h *DMHandler) UnpinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.UnpinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "unpinned"})
}

// GetPinnedMessages handles GET /api/dms/{channelId}/pinned
func (h *DMHandler) GetPinnedMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	messages, err := h.dmService.GetPinnedMessages(r.Context(), user.ID, channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, messages)
}

// ─── Search Endpoint ───

// SearchMessages handles GET /api/dms/{channelId}/search?q=&limit=&offset=
// FTS5 full-text search within a DM channel.
func (h *DMHandler) SearchMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.JSON(w, http.StatusOK, models.DMSearchResult{Messages: []models.DMMessage{}, TotalCount: 0})
		return
	}

	limit := 25
	offset := 0

	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	result, err := h.dmService.SearchMessages(r.Context(), user.ID, channelID, query, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}

// ToggleE2EE handles PATCH /api/dms/{channelId}/e2ee
// Enables or disables E2EE on a DM channel. Only human participants can toggle.
func (h *DMHandler) ToggleE2EE(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if user.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.dmService.ToggleE2EE(r.Context(), user.ID, channelID, req.Enabled)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}
