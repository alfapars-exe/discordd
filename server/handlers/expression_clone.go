// Package handlers — expression_clone.go: POST
// /api/servers/{serverId}/{emojis|stickers}/clone. The route gate has
// checked PermManageExpressions in the target server ({serverId}); the
// service checks source membership, same-server, copyable and copies the
// stored files.
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// cloneBodyMaxBytes caps the clone JSON body ({source_id, name?}).
const cloneBodyMaxBytes = 1 << 10

// ExpressionCloneHandler serves the clone routes; uploadLimiter is the
// shared upload budget (a clone writes files like an upload does).
type ExpressionCloneHandler struct {
	svc           services.ExpressionCloneService
	uploadLimiter *ratelimit.MessageRateLimiter
}

func NewExpressionCloneHandler(svc services.ExpressionCloneService, uploadLimiter *ratelimit.MessageRateLimiter) *ExpressionCloneHandler {
	return &ExpressionCloneHandler{svc: svc, uploadLimiter: uploadLimiter}
}

// cloneErrorCodes are the clone-only sentinels, checked before the
// kind-specific emoji/sticker mapping.
var cloneErrorCodes = []struct {
	err    error
	status int
	msg    string
	code   string
}{
	{models.ErrExpressionSourceInvalid, http.StatusBadRequest, "invalid source_id", "BAD_REQUEST"},
	{models.ErrExpressionNotFound, http.StatusNotFound, "expression not found", "EXPRESSION_NOT_FOUND"},
	{models.ErrExpressionNotCopyable, http.StatusForbidden, "this expression is not copyable", "EXPRESSION_NOT_COPYABLE"},
	{models.ErrExpressionCloneSameServer, http.StatusBadRequest,
		"the expression already belongs to this server", "EXPRESSION_CLONE_SAME_SERVER"},
}

func writeCloneError(w http.ResponseWriter, err error, fallback func(http.ResponseWriter, error)) {
	for _, c := range cloneErrorCodes {
		if errors.Is(err, c.err) {
			pkg.ErrorWithCode(w, c.status, c.msg, c.code)
			return
		}
	}
	fallback(w, err)
}

// decodeClone runs the shared prelude: user + server context, rate limit,
// bounded JSON body, Validate. ok is false once a response is written.
func (h *ExpressionCloneHandler) decodeClone(w http.ResponseWriter, r *http.Request) (userID, serverID string, req *models.CloneExpressionRequest, ok bool) {
	user, uok := r.Context().Value(UserContextKey).(*models.User)
	if !uok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return "", "", nil, false
	}
	serverID, sok := r.Context().Value(ServerIDContextKey).(string)
	if !sok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return "", "", nil, false
	}
	if uploadRateLimited(w, h.uploadLimiter, user.ID) {
		return "", "", nil, false
	}
	var body models.CloneExpressionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, cloneBodyMaxBytes)).Decode(&body); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return "", "", nil, false
	}
	return user.ID, serverID, &body, true
}

// CloneEmoji handles POST /api/servers/{serverId}/emojis/clone.
func (h *ExpressionCloneHandler) CloneEmoji(w http.ResponseWriter, r *http.Request) {
	userID, serverID, req, ok := h.decodeClone(w, r)
	if !ok {
		return
	}
	if err := req.Validate(); err != nil {
		writeCloneError(w, err, writeEmojiError)
		return
	}
	emoji, err := h.svc.CloneEmoji(r.Context(), serverID, userID, req)
	if err != nil {
		writeCloneError(w, err, writeEmojiError)
		return
	}
	pkg.JSON(w, http.StatusCreated, emoji)
}

// CloneSticker handles POST /api/servers/{serverId}/stickers/clone.
func (h *ExpressionCloneHandler) CloneSticker(w http.ResponseWriter, r *http.Request) {
	userID, serverID, req, ok := h.decodeClone(w, r)
	if !ok {
		return
	}
	if err := req.Validate(); err != nil {
		writeCloneError(w, err, writeStickerError)
		return
	}
	sticker, err := h.svc.CloneSticker(r.Context(), serverID, userID, req)
	if err != nil {
		writeCloneError(w, err, writeStickerError)
		return
	}
	pkg.JSON(w, http.StatusCreated, sticker)
}
