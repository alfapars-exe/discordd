package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"log/slog"
	"mime/multipart"
	"net/http"
)

func dmFormPointer(r *http.Request, key string) *string {
	value := r.FormValue(key)
	if value == "" {
		return nil
	}
	return &value
}

func (h *DMHandler) finishDMSend(r *http.Request, msg *models.DMMessage) error {
	if finalizer, ok := h.dmService.(interface {
		FinalizeDMCreate(context.Context, *models.DMMessage) error
	}); ok {
		if err := finalizer.FinalizeDMCreate(r.Context(), msg); err != nil {
			return err
		}
	}
	h.dmService.BroadcastCreate(msg)
	return nil
}
func (h *DMHandler) parseDMSend(w http.ResponseWriter, r *http.Request) (*models.CreateDMMessageRequest, bool) {
	var req models.CreateDMMessageRequest
	if !isMultipart(r.Header.Get("Content-Type")) {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return nil, false
		}
		return &req, true
	}
	if err := pkg.LimitedParseMultipartFormN(w, r, h.maxUploadSize, 10); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return nil, false
	}
	req.ClientMessageID = r.FormValue("client_message_id")
	req.Content = r.FormValue("content")
	req.ReplyToID = dmFormPointer(r, "reply_to_id")
	if r.FormValue("encryption_version") == "1" {
		req.EncryptionVersion = 1
		req.Ciphertext = dmFormPointer(r, "ciphertext")
		req.SenderDeviceID = dmFormPointer(r, "sender_device_id")
		req.E2EEMetadata = dmFormPointer(r, "e2ee_metadata")
	}
	req.HasFiles = r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0
	return &req, true
}

type dmUploadFailure struct {
	Filename string `json:"filename"`
	Error    string `json:"error"`
}

func (h *DMHandler) uploadDMSendFiles(r *http.Request, msg *models.DMMessage, isEncrypted bool) []dmUploadFailure {
	var dmUploadFailures []dmUploadFailure

	if isMultipart(r.Header.Get("Content-Type")) && r.MultipartForm != nil {
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				slog.WarnContext(r.Context(), "dm attachment open failed", "err", pkg.ErrText(err))
				dmUploadFailures = append(dmUploadFailures, dmUploadFailure{
					Filename: fileHeader.Filename,
					Error:    "could not open file",
				})
				continue
			}

			attachment, err := h.dmUploadService.Upload(r.Context(), msg.ID, file, fileHeader, isEncrypted)
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
					slog.WarnContext(r.Context(), "dm attachment upload failed", "err", pkg.ErrText(err))
				}
				dmUploadFailures = append(dmUploadFailures, dmUploadFailure{
					Filename: fileHeader.Filename,
					Error:    failMsg,
				})
				continue
			}

			msg.Attachments = append(msg.Attachments, *attachment)
		}
	}

	return dmUploadFailures
}

func (h *DMHandler) stageDMSendFiles(r *http.Request, user, channel string, req *models.CreateDMMessageRequest) (func(), error) {
	if r.MultipartForm == nil {
		return nil, fmt.Errorf("%w: multipart form required", pkg.ErrBadRequest)
	}
	for field, files := range r.MultipartForm.File {
		if field != "files" && len(files) > 0 {
			return nil, fmt.Errorf("%w: unsupported upload field", pkg.ErrBadRequest)
		}
	}
	if _, err := h.dmService.GetMessages(r.Context(), user, channel, "", 1); err != nil {
		return nil, err
	}
	stager, ok := h.dmUploadService.(interface {
		Stage(context.Context, multipart.File, *multipart.FileHeader, bool) (*models.DMAttachment, *models.DMUploadDigest, error)
		Discard(*models.DMAttachment)
	})
	if !ok {
		return nil, fmt.Errorf("%w: upload staging unavailable", pkg.ErrBadRequest)
	}
	cleanup := func() {
		for i := range req.StagedAttachments {
			stager.Discard(&req.StagedAttachments[i])
		}
	}
	for index, header := range r.MultipartForm.File["files"] {
		file, err := header.Open()
		if err != nil {
			cleanup()
			return nil, err
		}
		a, digest, err := stager.Stage(r.Context(), file, header, req.EncryptionVersion == 1)
		_ = file.Close()
		if err != nil {
			cleanup()
			return nil, err
		}
		a.UploadIndex = &index
		req.StagedAttachments = append(req.StagedAttachments, *a)
		req.UploadManifest = append(req.UploadManifest, *digest)
	}
	return cleanup, nil
}
