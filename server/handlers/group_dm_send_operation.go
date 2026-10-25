package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func groupSendRequestHash(req *models.CreateGroupDMMessageRequest, files []*multipart.FileHeader, maxSize int64) (string, error) {
	type fingerprint struct {
		Filename    string
		Size        int64
		ContentType string
		Digest      string
	}
	parts := make([]fingerprint, 0, len(files))
	for _, header := range files {
		f, err := header.Open()
		if err != nil {
			return "", err
		}
		hash := sha256.New()
		n, err := io.Copy(hash, io.LimitReader(f, maxSize+1))
		_ = f.Close()
		if err != nil {
			return "", err
		}
		if n > maxSize {
			return "", pkg.ErrBadRequest
		}
		parts = append(parts, fingerprint{header.Filename, n, header.Header.Get("Content-Type"), hex.EncodeToString(hash.Sum(nil))})
	}
	body, err := json.Marshal(struct {
		Request *models.CreateGroupDMMessageRequest
		Files   []fingerprint
	}{req, parts})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:]), nil
}

func writeGroupSendOutcome(w http.ResponseWriter, out *models.GroupSendOutcome) {
	if out.Operation.Phase == "cancelled" {
		pkg.ErrorWithCode(w, http.StatusGone, "the send operation was cancelled", "SEND_CANCELLED")
		return
	}
	if out.Operation.Phase == "deleted" {
		pkg.ErrorWithMessage(w, http.StatusGone, "the sent message was deleted")
		return
	}
	if out.Operation.Phase != "completed" {
		pkg.JSON(w, http.StatusAccepted, out)
		return
	}
	if len(out.Operation.FailedIndices) > 0 {
		failures := make([]map[string]any, 0, len(out.Operation.FailedIndices))
		for _, index := range out.Operation.FailedIndices {
			failures = append(failures, map[string]any{"filename": fmt.Sprintf("encrypted_%d.bin", index), "error": "upload failed", "file_key_index": index})
		}
		pkg.JSON(w, http.StatusMultiStatus, map[string]any{"message": out.Message, "upload_failures": failures})
		return
	}
	pkg.JSON(w, http.StatusCreated, out.Message)
}

func (h *GroupDMHandler) CancelSend(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, user.ID, "send cancellation") {
		return
	}
	out, err := h.service.CancelSend(r.Context(), r.PathValue("groupId"), user.ID, r.PathValue("requestId"))
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, out)
}

func (h *GroupDMHandler) GetSendOutcome(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	out, err := h.service.GetSendOutcome(r.Context(), r.PathValue("groupId"), user.ID, r.PathValue("requestId"))
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, out)
}

func (h *GroupDMHandler) ReconcileSend(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := groupDMUser(r)
	if !ok {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if groupDMRateLimited(w, h.actionLimiter, user.ID, "send reconciliation") {
		return
	}
	out, err := h.service.ReconcileSend(r.Context(), r.PathValue("groupId"), user.ID, r.PathValue("requestId"))
	if err != nil {
		pkg.ErrorCtxErr(r.Context(), w, err)
		return
	}
	writeGroupSendOutcome(w, out)
}
