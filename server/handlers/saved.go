package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// SavedHandler serves the caller's bookmarks (/api/users/me/saved). Every
// route is self-scoped: the service filters by the authenticated user, so
// d.auth is the whole gate.
type SavedHandler struct {
	savedService services.SavedService
}

func NewSavedHandler(savedService services.SavedService) *SavedHandler {
	return &SavedHandler{savedService: savedService}
}

// List handles GET /api/users/me/saved?before=<saved_id>&limit=20
// limit is clamped to 1..50 (default 20).
func (h *SavedHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	q := r.URL.Query()
	limit := models.SavedPageDefault
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > models.SavedPageMax {
		limit = models.SavedPageMax
	}

	page, err := h.savedService.List(r.Context(), user.ID, q.Get("before"), limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
}

// ListIDs handles GET /api/users/me/saved/ids
func (h *SavedHandler) ListIDs(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	ids, err := h.savedService.ListIDs(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, ids)
}

// Create handles POST /api/users/me/saved {message_id?, dm_message_id?, note?}
// 201 with the hydrated row on a new bookmark; 200 with the existing row when
// the message was already saved (idempotent).
func (h *SavedHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateSavedMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	saved, created, err := h.savedService.Save(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	pkg.JSON(w, status, saved)
}

// UpdateNote handles PATCH /api/users/me/saved/{id} {note}
// An empty or null note clears it. 404 covers both "no such row" and "not
// yours" — the service does not distinguish them, so ids cannot be probed.
func (h *SavedHandler) UpdateNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateSavedNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	saved, err := h.savedService.UpdateNote(r.Context(), user.ID, id, req.Note)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, saved)
}

// Delete handles DELETE /api/users/me/saved/{id} (same 404 rule as UpdateNote).
func (h *SavedHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.savedService.Delete(r.Context(), user.ID, id); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "saved message removed"})
}
