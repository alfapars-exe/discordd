package handlers

import (
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"io"
	"net/http"
)

type MediaLabelHandler struct{ service *services.MediaLabelService }

func NewMediaLabelHandler(service *services.MediaLabelService) *MediaLabelHandler {
	return &MediaLabelHandler{service: service}
}
func (h *MediaLabelHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := spamUser(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	entry := models.MediaLabel{SourceKind: q.Get("source_kind"), ChannelID: q.Get("channel_id"), MessageID: q.Get("message_id"), Revision: q.Get("revision"), Fingerprint: q.Get("fingerprint")}
	label, err := h.service.Get(r.Context(), user.ID, &entry)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"annotation": label})
}
func (h *MediaLabelHandler) Set(w http.ResponseWriter, r *http.Request)    { h.write(w, r, false) }
func (h *MediaLabelHandler) Delete(w http.ResponseWriter, r *http.Request) { h.write(w, r, true) }
func (h *MediaLabelHandler) write(w http.ResponseWriter, r *http.Request, remove bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := spamUser(w, r)
	if !ok {
		return
	}
	var entry models.MediaLabel
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entry); err != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	// All HTTP mutations must compare the version observed by the caller.
	// Empty means the caller observed no annotation, not an unconditional write.
	if entry.ExpectedVersion == nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	var err error
	if remove {
		err = h.service.Delete(r.Context(), user.ID, &entry)
	} else {
		err = h.service.Set(r.Context(), user.ID, &entry)
	}
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
