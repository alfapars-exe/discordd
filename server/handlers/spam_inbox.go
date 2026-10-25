package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type SpamInboxHandler struct{ service *services.SpamInboxService }

func NewSpamInboxHandler(service *services.SpamInboxService) *SpamInboxHandler {
	return &SpamInboxHandler{service: service}
}
func spamUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || user.IsBot {
		pkg.Error(w, pkg.ErrUnauthorized)
		return nil, false
	}
	return user, true
}
func (h *SpamInboxHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := spamUser(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := h.service.Page(r.Context(), user.ID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
}
func (h *SpamInboxHandler) Record(w http.ResponseWriter, r *http.Request) { h.write(w, r, "") }
func (h *SpamInboxHandler) Decisions(w http.ResponseWriter, r *http.Request) {
	user, ok := spamUser(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := h.service.Decisions(r.Context(), user.ID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
}
func (h *SpamInboxHandler) Restore(w http.ResponseWriter, r *http.Request) { h.write(w, r, "restored") }
func (h *SpamInboxHandler) Dismiss(w http.ResponseWriter, r *http.Request) {
	h.write(w, r, "dismissed")
}
func (h *SpamInboxHandler) write(w http.ResponseWriter, r *http.Request, status string) {
	user, ok := spamUser(w, r)
	if !ok {
		return
	}
	var entry models.SpamInboxEntry
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entry); err != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	var err error
	if status == "" {
		err = h.service.Record(r.Context(), user.ID, &entry)
	} else {
		err = h.service.Decide(r.Context(), user.ID, &entry, status)
	}
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
