package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

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

// historyCursor is the parsed ?before= | ?around= | ?after= selector shared
// by the channel and DM history endpoints. At most one may be set.
type historyCursor struct {
	before, around, after string
}

// parseHistoryCursor reads the three cursor params and rejects a request
// that combines them — each selects a different window shape, so a mix has
// no single meaning. ok is false after the 400 has been written.
func parseHistoryCursor(w http.ResponseWriter, q url.Values) (historyCursor, bool) {
	c := historyCursor{before: q.Get("before"), around: q.Get("around"), after: q.Get("after")}
	set := 0
	for _, v := range []string{c.before, c.around, c.after} {
		if v != "" {
			set++
		}
	}
	if set > 1 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "before, around and after are mutually exclusive")
		return c, false
	}
	return c, true
}

// List handles GET /api/channels/{id}/messages?before=ID&limit=50
// Cursor-based pagination: before=messageID for older messages (the default
// form), around=messageID for a window centred on a message, after=messageID
// for newer messages; the three are mutually exclusive. limit max 100.
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

	cursor, ok := parseHistoryCursor(w, r.URL.Query())
	if !ok {
		return
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	var page *models.MessagePage
	var err error
	switch {
	case cursor.around != "":
		page, err = h.messageService.GetAround(r.Context(), serverID, channelID, user.ID, cursor.around, limit)
	case cursor.after != "":
		page, err = h.messageService.GetAfter(r.Context(), serverID, channelID, user.ID, cursor.after, limit)
	default:
		page, err = h.messageService.GetByChannelID(r.Context(), serverID, channelID, user.ID, cursor.before, limit)
	}
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

	if isMultipart(contentType) {
		req.ClientMessageID = r.FormValue("client_message_id")
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
	}
	// Hash semantic request fields plus each file's bytes and name before any
	// durable mutation. Multipart boundaries and filenames alone aren't identity.
	hash := sha256.New()
	encoded, _ := json.Marshal(req)
	hash.Write(encoded)
	if r.MultipartForm != nil {
		for _, fh := range r.MultipartForm.File["files"] {
			req.FileNames = append(req.FileNames, fh.Filename)
			meta, _ := json.Marshal([]any{fh.Filename, fh.Size, fh.Header.Get("Content-Type")})
			hash.Write(meta)
			file, openErr := fh.Open()
			if openErr != nil {
				pkg.ErrorWithMessage(w, 400, "could not read attachment")
				return
			}
			_, readErr := io.Copy(hash, file)
			file.Close()
			if readErr != nil {
				pkg.ErrorWithMessage(w, 400, "could not read attachment")
				return
			}
		}
	}
	req.RequestHash = fmt.Sprintf("%x", hash.Sum(nil))
	message, err := h.messageService.Create(r.Context(), serverID, channelID, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if message.Replayed {
		pkg.JSON(w, http.StatusOK, message)
		return
	}
	if req.HasFiles {
		if durable, ok := h.messageService.(interface {
			KeepChannelSendAlive(context.Context, string) func()
		}); ok {
			defer durable.KeepChannelSendAlive(r.Context(), message.ID)()
		}
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
		for index, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				slog.WarnContext(r.Context(), "message attachment open failed", "err", pkg.ErrText(err))
				uploadFailures = append(uploadFailures, uploadFailure{
					Filename: fileHeader.Filename,
					Error:    "could not open file",
				})
				h.attachmentOutcome(message.ID, index, nil, "could not open file")
				continue
			}

			attachment, err := h.uploadService.Upload(context.WithValue(r.Context(), models.ChannelAttachmentIndexKey{}, index), message.ID, file, fileHeader, isEncrypted)
			// Read-side handle — nothing buffered to flush, safe to ignore.
			// Not deferred — this runs per file in the loop above; a defer
			// here would pin every attachment's handle open until the whole
			// handler returns instead of closing each one as its own
			// upload finishes.
			_ = file.Close()
			if err != nil {
				// Client-safe detail only for domain (4xx-shaped) errors —
				// infrastructure failures carry paths/driver text and stay
				// server-side (CWE-209).
				failMsg := "upload failed"
				if errors.Is(err, pkg.ErrBadRequest) {
					failMsg = pkg.ErrText(err)
				} else {
					slog.WarnContext(r.Context(), "message attachment upload failed", "err", pkg.ErrText(err))
				}
				uploadFailures = append(uploadFailures, uploadFailure{
					Filename: fileHeader.Filename,
					Error:    failMsg,
				})
				h.attachmentOutcome(message.ID, index, nil, failMsg)
				continue
			}

			message.Attachments = append(message.Attachments, *attachment)
			h.attachmentOutcome(message.ID, index, attachment, "")
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
	if durable, ok := h.messageService.(interface {
		CompleteChannelSend(context.Context, *models.Message) error
	}); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := durable.CompleteChannelSend(ctx, message); err != nil {
			slog.Error("channel send completion deferred to recovery")
		}
		cancel()
	} else {
		logx.Go("handlers.message.broadcast", func() { h.messageService.BroadcastCreate(message) })
	}

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

func (h *MessageHandler) attachmentOutcome(id string, index int, a *models.Attachment, failure string) {
	if durable, ok := h.messageService.(interface {
		AttachmentOutcome(context.Context, string, int, *models.Attachment, string) error
	}); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := durable.AttachmentOutcome(ctx, id, index, a, failure); err != nil {
			slog.Error("channel attachment state persistence failed")
		}
	}
}

func (h *MessageHandler) Events(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	server, _ := r.Context().Value(ServerIDContextKey).(string)
	after, err := strconv.ParseInt(r.URL.Query().Get("after_sequence"), 10, 64)
	if err != nil || after < 0 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	reader, ok := h.messageService.(interface {
		ChannelEvents(context.Context, string, string, string, int64) (*services.ChannelEventPage, error)
	})
	if !ok {
		pkg.Error(w, pkg.ErrNotFound)
		return
	}
	page, err := reader.ChannelEvents(r.Context(), server, r.PathValue("id"), user.ID, after)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, page)
}

func (h *MessageHandler) DeliveryHealth(w http.ResponseWriter, r *http.Request) {
	monitor, ok := h.messageService.(interface {
		ChannelDeliveryHealth(context.Context) (*services.ChannelDeliveryHealth, error)
	})
	if !ok {
		pkg.Error(w, pkg.ErrNotFound)
		return
	}
	health, err := monitor.ChannelDeliveryHealth(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, health)
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
