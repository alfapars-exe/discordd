package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// UserNoteHandler serves the caller's private note about another user
// (/api/users/{userId}/note). Owner-scoped inside the service: the path's
// userId is the note's TARGET, the owner is always the authenticated caller.
type UserNoteHandler struct {
	noteService services.UserNoteService
}

func NewUserNoteHandler(noteService services.UserNoteService) *UserNoteHandler {
	return &UserNoteHandler{noteService: noteService}
}

// Get handles GET /api/users/{userId}/note → {note: "", updated_at: null}
// when nothing is stored.
func (h *UserNoteHandler) Get(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("userId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	note, err := h.noteService.Get(r.Context(), user.ID, targetID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, note)
}

// Set handles PUT /api/users/{userId}/note {note}. An empty note deletes the
// row and answers {note: "", updated_at: null}.
func (h *UserNoteHandler) Set(w http.ResponseWriter, r *http.Request) {
	targetID := r.PathValue("userId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpsertUserNoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	note, err := h.noteService.Set(r.Context(), user.ID, targetID, req.Note)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, note)
}
