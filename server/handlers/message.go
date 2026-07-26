package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// MessageHandler handles message endpoints.
// messageLimiter is the CHANNEL-message budget (per-user sliding window);
// DMHandler carries its own separate instance so the two surfaces can't
// starve each other. uploadLimiter is a separate per-user cap that only
// fires on multipart requests (20/min); text-only sends don't touch it.
type MessageHandler struct {
	messageService services.MessageService
	uploadService  services.UploadService
	maxUploadSize  int64
	messageLimiter *ratelimit.MessageRateLimiter
	uploadLimiter  *ratelimit.MessageRateLimiter
}

func NewMessageHandler(
	messageService services.MessageService,
	uploadService services.UploadService,
	maxUploadSize int64,
	messageLimiter *ratelimit.MessageRateLimiter,
	uploadLimiter *ratelimit.MessageRateLimiter,
) *MessageHandler {
	return &MessageHandler{
		messageService: messageService,
		uploadService:  uploadService,
		maxUploadSize:  maxUploadSize,
		messageLimiter: messageLimiter,
		uploadLimiter:  uploadLimiter,
	}
}

// List handles GET /api/channels/{id}/messages?before=ID&limit=50
// Cursor-based pagination: before=messageID for older messages, limit max 100.
func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	beforeID := r.URL.Query().Get("before")

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	page, err := h.messageService.GetByChannelID(r.Context(), serverID, channelID, user.ID, beforeID, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// Create handles POST /api/channels/{id}/messages
// Accepts JSON or multipart/form-data (for file attachments).
func (h *MessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

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

	// Upload-specific throttle (T3.5): the message limiter above (5/5s)
	// stops a burst; the upload limiter (20/min) stops sustained
	// storage/bandwidth abuse. Applied ONLY to multipart requests so a
	// user pounding text messages doesn't exhaust the upload budget.
	if isMultipart(contentType) && h.uploadLimiter != nil && !h.uploadLimiter.Allow(user.ID) {
		retryAfter := h.uploadLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many uploads, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.CreateMessageRequest

	if isMultipart(contentType) {
		// LimitedParseMultipartFormN caps the request body at
		// `maxUploadSize * 10 + overhead` BEFORE the parser starts spilling
		// to disk — without this gate Go's multipart parser walks the
		// entire body to /tmp before it ever returns, so a malicious
		// client can pin gigabytes of disk per request even though
		// per-file size is small.
		if err := pkg.LimitedParseMultipartFormN(w, r, h.maxUploadSize, 10); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}

		req.Content = r.FormValue("content")
		if replyTo := r.FormValue("reply_to_id"); replyTo != "" {
			req.ReplyToID = &replyTo
		}

		// E2EE fields from multipart. When encryption_version=1 the client
		// MUST supply both ciphertext and sender_device_id together —
		// without both, the server's decrypt-side (DM fanout, E2EE log
		// audit, search index suppression) can't route the message at all
		// and the recipients would just see a permanently-undecryptable
		// blob. Reject the inconsistent shape upfront so the failure is
		// loud instead of materializing later as a "missing E2EE field"
		// surprise during peer decrypt.
		if ev := r.FormValue("encryption_version"); ev == "1" {
			req.EncryptionVersion = 1
			ct := r.FormValue("ciphertext")
			sd := r.FormValue("sender_device_id")
			if ct == "" || sd == "" {
				pkg.ErrorWithMessage(w, http.StatusBadRequest,
					"encryption_version=1 requires both ciphertext and sender_device_id")
				return
			}
			req.Ciphertext = &ct
			req.SenderDeviceID = &sd
			if em := r.FormValue("e2ee_metadata"); em != "" {
				req.E2EEMetadata = &em
			}
		} else if r.FormValue("ciphertext") != "" || r.FormValue("sender_device_id") != "" {
			// Plaintext path: a client must not smuggle half an E2EE payload
			// (ciphertext without the version flag) past mass-assignment.
			pkg.ErrorWithMessage(w, http.StatusBadRequest,
				"ciphertext/sender_device_id provided without encryption_version=1")
			return
		}

		if r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0 {
			req.HasFiles = true
		}
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	message, err := h.messageService.Create(r.Context(), serverID, channelID, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Upload files after message creation. Failures used to be silently
	// swallowed via `continue` — the message would land without its
	// attachments and the user had no idea anything went wrong. We now
	// collect per-file failures and surface them on the response so the
	// client can re-render the message with explicit error chips.
	type uploadFailure struct {
		Filename string `json:"filename"`
		Error    string `json:"error"`
	}
	var uploadFailures []uploadFailure

	if isMultipart(contentType) && r.MultipartForm != nil {
		isEncrypted := req.EncryptionVersion == 1
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				uploadFailures = append(uploadFailures, uploadFailure{
					Filename: fileHeader.Filename,
					Error:    fmt.Sprintf("could not open file: %v", err),
				})
				continue
			}

			attachment, err := h.uploadService.Upload(r.Context(), message.ID, file, fileHeader, isEncrypted)
			_ = file.Close()
			if err != nil {
				uploadFailures = append(uploadFailures, uploadFailure{
					Filename: fileHeader.Filename,
					Error:    err.Error(),
				})
				continue
			}

			message.Attachments = append(message.Attachments, *attachment)
		}
	}

	// Set transient server_id so clients can route cross-server notifications.
	// Must happen BEFORE the broadcast goroutine spawns — after this point
	// `message` is read-only (both the JSON encode below and the broadcast
	// goroutine only read it; adding a later mutation would be a data race).
	message.ServerID = serverID

	// Broadcast after uploads so all clients see attachments — but OFF the
	// request goroutine: allowedViewers costs a channel fetch + bulk perms
	// resolve (up to the 5s broadcast budget) against a small remote DB pool,
	// and the 201 must not wait on it. The sender's own view doesn't depend
	// on the echo either — the client inserts this response body directly.
	logx.Go("handlers.message.broadcast", func() {
		h.messageService.BroadcastCreate(message)
	})

	// If some attachments failed to upload, return a multi-status response
	// (the message itself was created, but some files didn't make it). The
	// client should display the message with explicit failure markers per
	// file so the user can retry the upload instead of silently losing data.
	if len(uploadFailures) > 0 {
		pkg.JSON(w, http.StatusMultiStatus, map[string]any{
			"message":         message,
			"upload_failures": uploadFailures,
		})
		return
	}

	pkg.JSON(w, http.StatusCreated, message)
}

// Update handles PATCH /api/messages/{id} (owner only).
func (h *MessageHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	message, err := h.messageService.Update(r.Context(), serverID, id, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, message)
}

// Delete handles DELETE /api/messages/{id} (owner or MANAGE_MESSAGES permission).
func (h *MessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perms, _ := r.Context().Value(PermissionsContextKey).(models.Permission)

	if err := h.messageService.Delete(r.Context(), serverID, id, user.ID, perms); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}

// PermissionsContextKey carries the user's effective permissions in request context.
const PermissionsContextKey contextKey = "permissions"

func isMultipart(contentType string) bool {
	return len(contentType) >= 19 && contentType[:19] == "multipart/form-data"
}
