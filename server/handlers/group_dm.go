package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

type GroupDMHandler struct {
	service        services.GroupDMService
	upload         services.GroupDMUploadService
	maxUploadSize  int64
	messageLimiter *ratelimit.MessageRateLimiter
	actionLimiter  *ratelimit.MessageRateLimiter
	uploadLimiter  *ratelimit.MessageRateLimiter
}

func NewGroupDMHandler(service services.GroupDMService, upload services.GroupDMUploadService, maxUploadSize int64, messageLimiter, actionLimiter, uploadLimiter *ratelimit.MessageRateLimiter) *GroupDMHandler {
	return &GroupDMHandler{service: service, upload: upload, maxUploadSize: maxUploadSize, messageLimiter: messageLimiter, actionLimiter: actionLimiter, uploadLimiter: uploadLimiter}
}

func groupDMRateLimited(w http.ResponseWriter, limiter *ratelimit.MessageRateLimiter, userID, noun string) bool {
	if limiter == nil || limiter.Allow(userID) {
		return false
	}
	retryAfter := limiter.CooldownSeconds(userID)
	w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
	pkg.ErrorWithMessage(w, http.StatusTooManyRequests, fmt.Sprintf("too many %s, please wait %s", noun, ratelimit.FormatRetryMessage(retryAfter)))
	return true
}

func groupDMUser(r *http.Request) (*models.User, bool) {
	u, ok := r.Context().Value(UserContextKey).(*models.User)
	return u, ok && u != nil
}

func groupDMAccountMatches(w http.ResponseWriter, r *http.Request, u *models.User) bool {
	if expected := r.URL.Query().Get("expected_user_id"); expected != "" && expected != u.ID {
		pkg.ErrorWithCode(w, http.StatusConflict, "group account changed", "GROUP_ACCOUNT_MISMATCH")
		return false
	}
	return true
}

func decodeGroupJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func (h *GroupDMHandler) Create(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, u.ID, "group changes") {
		return
	}
	var req models.CreateGroupDMRequest
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	g, err := h.service.Create(r.Context(), u.ID, &req)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, g)
}

func (h *GroupDMHandler) List(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	items, err := h.service.List(r.Context(), u.ID)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"group_dms": items})
}

func (h *GroupDMHandler) Get(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	g, err := h.service.Get(r.Context(), r.PathValue("groupId"), u.ID)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, g)
}

func (h *GroupDMHandler) Update(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	var req models.UpdateGroupDMRequest
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	g, err := h.service.Update(r.Context(), r.PathValue("groupId"), u.ID, &req)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, g)
}

func (h *GroupDMHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, u) {
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, u.ID, "group changes") {
		return
	}
	var req struct {
		UserID string `json:"user_id"`
	}
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.UserID) == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}
	g, err := h.service.AddMember(r.Context(), r.PathValue("groupId"), u.ID, strings.TrimSpace(req.UserID))
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, g)
}

func (h *GroupDMHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, u) {
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, u.ID, "group changes") {
		return
	}
	g, err := h.service.RemoveMember(r.Context(), r.PathValue("groupId"), u.ID, r.PathValue("userId"))
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, g)
}

func (h *GroupDMHandler) Leave(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if !groupDMAccountMatches(w, r, u) {
		return
	}
	if err := h.service.Leave(r.Context(), r.PathValue("groupId"), u.ID); err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *GroupDMHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if around := strings.TrimSpace(r.URL.Query().Get("around")); around != "" {
		page, err := h.service.GetMessagesAround(r.Context(), r.PathValue("groupId"), u.ID, around, limit)
		if err != nil {
			pkg.ErrorCtxErr(r.Context(), w, err)
			return
		}
		pkg.JSON(w, http.StatusOK, page)
		return
	}
	items, err := h.service.ListMessages(r.Context(), r.PathValue("groupId"), u.ID, r.URL.Query().Get("before"), limit)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"messages": items})
}

func (h *GroupDMHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.messageLimiter, u.ID, "messages") {
		return
	}
	var req models.CreateGroupDMMessageRequest
	multipartRequest := isMultipart(r.Header.Get("Content-Type"))
	if multipartRequest {
		if groupDMRateLimited(w, h.uploadLimiter, u.ID, "uploads") {
			return
		}
		if err := pkg.LimitedParseMultipartFormN(w, r, h.maxUploadSize, 10); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}
		ct := r.FormValue("ciphertext")
		device := r.FormValue("sender_device_id")
		metadata := r.FormValue("e2ee_metadata")
		req.Ciphertext = &ct
		req.SenderDeviceID = &device
		req.E2EEMetadata = &metadata
		req.ClientRequestID = r.FormValue("client_request_id")
		req.KeyEpoch, _ = strconv.ParseInt(r.FormValue("key_epoch"), 10, 64)
		if reply := r.FormValue("reply_to_id"); reply != "" {
			req.ReplyToID = &reply
		}
	} else if !decodeGroupJSON(w, r, &req) {
		return
	}
	if req.ClientRequestID != "" {
		if err := req.Validate(); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid send operation payload")
			return
		}
		var files []*multipart.FileHeader
		if r.MultipartForm != nil {
			files = r.MultipartForm.File["files"]
		}
		hash, hashErr := groupSendRequestHash(&req, files, h.maxUploadSize)
		if hashErr != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid send operation payload")
			return
		}
		op, opErr := h.service.PrepareSend(r.Context(), r.PathValue("groupId"), u.ID, &req, hash, len(files))
		if opErr != nil {
			pkg.ErrorCtxErr(r.Context(), w, opErr)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if op.Phase != "prepared" {
			out, outErr := h.service.GetSendOutcome(r.Context(), r.PathValue("groupId"), u.ID, req.ClientRequestID)
			if outErr != nil {
				pkg.ErrorCtxErr(r.Context(), w, outErr)
				return
			}
			writeGroupSendOutcome(w, out)
			return
		}
	}
	m, err := h.service.SendMessage(r.Context(), r.PathValue("groupId"), u.ID, &req)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	type uploadFailure struct {
		Filename     string `json:"filename"`
		Error        string `json:"error"`
		FileKeyIndex int    `json:"file_key_index"`
	}
	failures := []uploadFailure{}
	if multipartRequest && r.MultipartForm != nil {
		for index, header := range r.MultipartForm.File["files"] {
			file, openErr := header.Open()
			if openErr != nil {
				failures = append(failures, uploadFailure{header.Filename, "could not open file", index})
				continue
			}
			attachment, uploadErr := h.upload.Upload(r.Context(), m.ID, file, header, index)
			_ = file.Close()
			if uploadErr != nil {
				failures = append(failures, uploadFailure{header.Filename, "upload failed", index})
				continue
			}
			m.Attachments = append(m.Attachments, *attachment)
		}
	}
	if req.ClientRequestID != "" {
		failed := make([]int, 0, len(failures))
		for _, failure := range failures {
			failed = append(failed, failure.FileKeyIndex)
		}
		if _, err = h.service.CompleteSend(r.Context(), m.GroupID, u.ID, req.ClientRequestID, failed); err != nil {
			pkg.ErrorCtxErr(r.Context(), w, err)
			return
		}
	}
	if err := h.service.BroadcastMessage(r.Context(), m); err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	if len(failures) > 0 {
		pkg.JSON(w, http.StatusMultiStatus, map[string]any{"message": m, "upload_failures": failures})
		return
	}
	pkg.JSON(w, http.StatusCreated, m)
}

func (h *GroupDMHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.messageLimiter, u.ID, "messages") {
		return
	}
	var req models.UpdateGroupDMMessageRequest
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	m, err := h.service.EditMessage(r.Context(), r.PathValue("groupId"), r.PathValue("messageId"), u.ID, &req)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, m)
}
func (h *GroupDMHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if err := h.service.DeleteMessage(r.Context(), r.PathValue("groupId"), r.PathValue("messageId"), u.ID); err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *GroupDMHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	var req models.ToggleDMReactionRequest
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "emoji is required")
		return
	}
	if err := h.service.ToggleReaction(r.Context(), r.PathValue("groupId"), r.PathValue("messageId"), u.ID, req.Emoji); err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
func (h *GroupDMHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	var req struct {
		MessageID *string `json:"message_id"`
	}
	if r.ContentLength != 0 && !decodeGroupJSON(w, r, &req) {
		return
	}
	state, err := h.service.MarkRead(r.Context(), r.PathValue("groupId"), u.ID, req.MessageID)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}

func (h *GroupDMHandler) MarkUnread(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, u.ID, "group read changes") {
		return
	}
	var req struct {
		MessageID string `json:"message_id"`
	}
	if !decodeGroupJSON(w, r, &req) {
		return
	}
	state, err := h.service.MarkUnreadFrom(r.Context(), r.PathValue("groupId"), u.ID, req.MessageID)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, state)
}

func (h *GroupDMHandler) CallToken(w http.ResponseWriter, r *http.Request) {
	u, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	result, err := h.service.GenerateCallToken(r.Context(), r.PathValue("groupId"), u.ID)
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, result)
}
