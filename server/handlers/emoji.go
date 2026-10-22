// Package handlers — emoji.go: per-server custom emoji endpoints.
//
// Upload order is cheapest-first: rate limit, multipart cap, name rules,
// name/cap precheck, then the image pipeline (ProcessExpressionImage), and
// only then the service writes files and inserts the row. Only the form
// fields file, display_name, name and copyable are ever read — URLs and the
// creator are always server-generated.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// emojiPatchMaxBytes caps the PATCH JSON body (three short fields).
const emojiPatchMaxBytes = 4 << 10

// EmojiHandler serves the custom emoji routes. uploadLimiter is the shared
// per-user upload budget (nil = disabled), same as avatar uploads.
type EmojiHandler struct {
	svc           services.EmojiService
	uploadLimiter *ratelimit.MessageRateLimiter
}

func NewEmojiHandler(svc services.EmojiService, uploadLimiter *ratelimit.MessageRateLimiter) *EmojiHandler {
	return &EmojiHandler{svc: svc, uploadLimiter: uploadLimiter}
}

// expressionErrorCodes pairs each expression sentinel with its status, a
// fixed client message (CWE-209) and a machine-readable code.
var expressionErrorCodes = []struct {
	err    error
	status int
	msg    string
	code   string
}{
	{models.ErrExpressionNameInvalid, http.StatusBadRequest,
		"emoji name must be 2-32 characters of a-z, 0-9 and _", "EXPRESSION_NAME_INVALID"},
	{models.ErrExpressionDisplayNameInvalid, http.StatusBadRequest,
		"display name must be 1-32 characters without control or formatting characters", "EXPRESSION_DISPLAY_NAME_INVALID"},
	{models.ErrExpressionNameTaken, http.StatusConflict,
		"an emoji with this name already exists in this server", "EXPRESSION_NAME_TAKEN"},
	{models.ErrExpressionLimitReached, http.StatusBadRequest,
		"this server has reached its emoji limit", "EXPRESSION_LIMIT_REACHED"},
	{models.ErrExpressionLicenseCreatorOnly, http.StatusForbidden,
		"only the emoji's creator can change whether it is copyable", "EXPRESSION_LICENSE_CREATOR_ONLY"},
	{models.ErrExpressionLicenseLocked, http.StatusForbidden,
		"this emoji is a copy; its licence cannot be changed", "EXPRESSION_LICENSE_LOCKED"},
}

// writeEmojiError writes err with its EXPRESSION_* code when it is one of
// the expression sentinels; everything else goes through writeUploadError
// (ErrImageBusy → 503, the rest via pkg.Error's sentinel map).
func writeEmojiError(w http.ResponseWriter, err error) {
	for _, c := range expressionErrorCodes {
		if errors.Is(err, c.err) {
			pkg.ErrorWithCode(w, c.status, c.msg, c.code)
			return
		}
	}
	writeUploadError(w, err)
}

// emojiAnimatedTooLargeMsg replaces ErrAnimatedTooLarge's avatar wording on
// emoji uploads.
const emojiAnimatedTooLargeMsg = "animated emoji is too large after processing (max 512KB)"

// writeEmojiImageError writes an image-pipeline failure: ErrAnimatedTooLarge
// gets an emoji-specific fixed message, everything else the shared avatar
// mapping (imagePipelineError, then 503 for ErrImageBusy).
func writeEmojiImageError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrAnimatedTooLarge) {
		pkg.ErrorWithCode(w, http.StatusBadRequest, emojiAnimatedTooLargeMsg, "BAD_REQUEST")
		return
	}
	writeEmojiError(w, imagePipelineError(err))
}

func (h *EmojiHandler) rateLimited(w http.ResponseWriter, userID string) bool {
	if h.uploadLimiter == nil || h.uploadLimiter.Allow(userID) {
		return false
	}
	retryAfter := h.uploadLimiter.CooldownSeconds(userID)
	w.Header().Set(retryAfterHeader, fmt.Sprintf("%d", retryAfter))
	pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
		fmt.Sprintf("too many uploads, please wait %s", ratelimit.FormatRetryMessage(retryAfter)))
	return true
}

// formField returns the first multipart (body) value of key — never a URL
// query parameter, unlike r.FormValue.
func formField(r *http.Request, key string) string {
	if r.MultipartForm == nil {
		return ""
	}
	if v := r.MultipartForm.Value[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// List handles GET /api/servers/{serverId}/emojis.
func (h *EmojiHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	emojis, err := h.svc.List(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, emojis)
}

// ListMine handles GET /api/users/me/emojis — the emojis of every server
// the caller belongs to.
func (h *EmojiHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	emojis, err := h.svc.ListMine(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, emojis)
}

// Create handles POST /api/servers/{serverId}/emojis (multipart: file,
// display_name, optional name, optional copyable "true"/"false").
func (h *EmojiHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	if h.rateLimited(w, user.ID) {
		return
	}

	if err := pkg.LimitedParseMultipartForm(w, r, models.ExpressionMaxUploadBytes); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()
	if header.Size > models.ExpressionMaxUploadBytes {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file too large (max 512KB)")
		return
	}

	var copyable bool
	switch formField(r, "copyable") {
	case "", "false":
	case "true":
		copyable = true
	default:
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "copyable must be true or false")
		return
	}

	req := &models.CreateEmojiRequest{
		Name:        formField(r, "name"),
		DisplayName: formField(r, "display_name"),
		Copyable:    copyable,
	}
	if err := req.Validate(); err != nil {
		writeEmojiError(w, err)
		return
	}
	if err := h.svc.PrecheckCreate(r.Context(), serverID, req); err != nil {
		writeEmojiError(w, err)
		return
	}

	img, err := ProcessExpressionImage(r.Context(), file, ExpressionEmoji)
	if err != nil {
		writeEmojiImageError(w, err)
		return
	}

	emoji, err := h.svc.Create(r.Context(), serverID, user.ID, req, img.Static, img.Animated)
	if err != nil {
		writeEmojiError(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, emoji)
}

// Update handles PATCH /api/servers/{serverId}/emojis/{emojiId}
// {name?, display_name?, copyable?}.
func (h *EmojiHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.UpdateEmojiRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, emojiPatchMaxBytes)).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := req.Validate(); err != nil {
		writeEmojiError(w, err)
		return
	}

	emoji, err := h.svc.Update(r.Context(), serverID, r.PathValue("emojiId"), user.ID, &req)
	if err != nil {
		writeEmojiError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, emoji)
}

// Delete handles DELETE /api/servers/{serverId}/emojis/{emojiId}.
func (h *EmojiHandler) Delete(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	if err := h.svc.Delete(r.Context(), serverID, r.PathValue("emojiId")); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
