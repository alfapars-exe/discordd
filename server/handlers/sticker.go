// Package handlers — sticker.go: per-server sticker endpoints.
//
// Same upload order as emoji.go: rate limit, multipart cap, metadata rules,
// name/cap precheck, then the image pipeline (ProcessExpressionImage with
// the ExpressionSticker profile), and only then the service writes files and
// inserts the row. Only the form fields file, display_name, name,
// description, tags and copyable are ever read — URLs, the creator and
// cloned_from are always server-generated.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// ExpressionSticker is the sticker profile: 320 px fit, 4 MP static decode
// ceiling, 1 MiB animated output (a GIF re-quantised at 320 px can come out
// larger than its ≤512 KiB source).
var ExpressionSticker = ExpressionProfile{Dim: 320, MaxDecodePixels: 4_000_000, MaxAnimatedOutput: 1 << 20}

// stickerPatchMaxBytes caps the PATCH JSON body (five short fields).
const stickerPatchMaxBytes = 4 << 10

// StickerHandler serves the sticker routes. uploadLimiter is the shared
// per-user upload budget (nil = disabled), same as emoji uploads.
type StickerHandler struct {
	svc           services.StickerService
	uploadLimiter *ratelimit.MessageRateLimiter
}

func NewStickerHandler(svc services.StickerService, uploadLimiter *ratelimit.MessageRateLimiter) *StickerHandler {
	return &StickerHandler{svc: svc, uploadLimiter: uploadLimiter}
}

// stickerErrorCodes maps the shared expression sentinels to sticker-worded
// fixed messages (CWE-209) and their EXPRESSION_* codes.
var stickerErrorCodes = []struct {
	err    error
	status int
	msg    string
	code   string
}{
	{models.ErrExpressionNameInvalid, http.StatusBadRequest,
		"sticker name must be 2-32 characters of a-z, 0-9 and _", "EXPRESSION_NAME_INVALID"},
	{models.ErrExpressionDisplayNameInvalid, http.StatusBadRequest,
		"display name must be 1-32 characters without control or formatting characters", "EXPRESSION_DISPLAY_NAME_INVALID"},
	{models.ErrExpressionDescriptionInvalid, http.StatusBadRequest,
		"description must be at most 100 characters on one line without control or formatting characters", "EXPRESSION_DESCRIPTION_INVALID"},
	{models.ErrExpressionTagsInvalid, http.StatusBadRequest,
		"at most 5 tags of 1-20 characters, without commas, control or formatting characters", "EXPRESSION_TAGS_INVALID"},
	{models.ErrExpressionNameTaken, http.StatusConflict,
		"a sticker with this name already exists in this server", "EXPRESSION_NAME_TAKEN"},
	{models.ErrExpressionLimitReached, http.StatusBadRequest,
		"this server has reached its sticker limit", "EXPRESSION_LIMIT_REACHED"},
	{models.ErrExpressionLicenseCreatorOnly, http.StatusForbidden,
		"only the sticker's creator can change whether it is copyable", "EXPRESSION_LICENSE_CREATOR_ONLY"},
	{models.ErrExpressionLicenseLocked, http.StatusForbidden,
		"this sticker is a copy; its licence cannot be changed", "EXPRESSION_LICENSE_LOCKED"},
}

// writeStickerError writes err with its EXPRESSION_* code when it is one of
// the expression sentinels; everything else goes through writeUploadError.
func writeStickerError(w http.ResponseWriter, err error) {
	for _, c := range stickerErrorCodes {
		if errors.Is(err, c.err) {
			pkg.ErrorWithCode(w, c.status, c.msg, c.code)
			return
		}
	}
	writeUploadError(w, err)
}

// stickerAnimatedTooLargeMsg replaces ErrAnimatedTooLarge's avatar wording.
const stickerAnimatedTooLargeMsg = "animated sticker is too large after processing (max 1MB)"

// writeStickerImageError writes an image-pipeline failure (same mapping as
// writeEmojiImageError, sticker wording).
func writeStickerImageError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrAnimatedTooLarge) {
		pkg.ErrorWithCode(w, http.StatusBadRequest, stickerAnimatedTooLargeMsg, "BAD_REQUEST")
		return
	}
	writeStickerError(w, imagePipelineError(err))
}

// uploadRateLimited is EmojiHandler.rateLimited for a bare limiter: true
// (with a 429 and Retry-After written) when userID is over budget.
func uploadRateLimited(w http.ResponseWriter, limiter *ratelimit.MessageRateLimiter, userID string) bool {
	if limiter == nil || limiter.Allow(userID) {
		return false
	}
	retryAfter := limiter.CooldownSeconds(userID)
	w.Header().Set(retryAfterHeader, fmt.Sprintf("%d", retryAfter))
	pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
		fmt.Sprintf("too many uploads, please wait %s", ratelimit.FormatRetryMessage(retryAfter)))
	return true
}

// List handles GET /api/servers/{serverId}/stickers.
func (h *StickerHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	stickers, err := h.svc.List(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, stickers)
}

// ListMine handles GET /api/users/me/stickers — the stickers of every
// server the caller belongs to.
func (h *StickerHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	stickers, err := h.svc.ListMine(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, stickers)
}

// Create handles POST /api/servers/{serverId}/stickers (multipart: file,
// display_name, optional name, description, tags (comma-separated) and
// copyable "true"/"false").
func (h *StickerHandler) Create(w http.ResponseWriter, r *http.Request) {
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

	if uploadRateLimited(w, h.uploadLimiter, user.ID) {
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

	var tags []string
	if raw := formField(r, "tags"); raw != "" {
		tags = strings.Split(raw, ",")
	}
	req := &models.CreateStickerRequest{
		Name:        formField(r, "name"),
		DisplayName: formField(r, "display_name"),
		Description: formField(r, "description"),
		Tags:        tags,
		Copyable:    copyable,
	}
	if err := req.Validate(); err != nil {
		writeStickerError(w, err)
		return
	}
	if err := h.svc.PrecheckCreate(r.Context(), serverID, req); err != nil {
		writeStickerError(w, err)
		return
	}

	img, err := ProcessExpressionImage(r.Context(), file, ExpressionSticker)
	if err != nil {
		writeStickerImageError(w, err)
		return
	}

	sticker, err := h.svc.Create(r.Context(), serverID, user.ID, req, img.Static, img.Animated)
	if err != nil {
		writeStickerError(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, sticker)
}

// Update handles PATCH /api/servers/{serverId}/stickers/{stickerId}
// {name?, display_name?, description?, tags?, copyable?}.
func (h *StickerHandler) Update(w http.ResponseWriter, r *http.Request) {
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

	var req models.UpdateStickerRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, stickerPatchMaxBytes)).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := req.Validate(); err != nil {
		writeStickerError(w, err)
		return
	}

	sticker, err := h.svc.Update(r.Context(), serverID, r.PathValue("stickerId"), user.ID, &req)
	if err != nil {
		writeStickerError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, sticker)
}

// Delete handles DELETE /api/servers/{serverId}/stickers/{stickerId}.
func (h *StickerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	if err := h.svc.Delete(r.Context(), serverID, r.PathValue("stickerId")); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
