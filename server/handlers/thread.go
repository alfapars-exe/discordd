package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type ThreadHandler struct{ service services.ThreadService }

func NewThreadHandler(service services.ThreadService) *ThreadHandler {
	return &ThreadHandler{service: service}
}

func threadContext(r *http.Request) (*models.User, string, bool) {
	u, ok := r.Context().Value(UserContextKey).(*models.User)
	serverID, sok := r.Context().Value(ServerIDContextKey).(string)
	return u, serverID, ok && u != nil && sok && serverID != ""
}
func threadAccountMatches(w http.ResponseWriter, r *http.Request, u *models.User) bool {
	if expected := r.URL.Query().Get("expected_user_id"); expected != "" && expected != u.ID {
		pkg.ErrorWithCode(w, http.StatusConflict, "thread account changed", "THREAD_ACCOUNT_MISMATCH")
		return false
	}
	return true
}
func (h *ThreadHandler) Create(w http.ResponseWriter, r *http.Request) {
	u, sid, ok := threadContext(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !threadAccountMatches(w, r, u) {
		return
	}
	var req models.CreateThreadRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	thread, err := h.service.Create(r.Context(), sid, r.PathValue("channelId"), u.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, thread)
}
func (h *ThreadHandler) List(w http.ResponseWriter, r *http.Request) {
	u, sid, ok := threadContext(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !threadAccountMatches(w, r, u) {
		return
	}
	items, err := h.service.List(r.Context(), sid, r.PathValue("channelId"), u.ID, r.URL.Query().Get("archived") == "true")
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"threads": items})
}
func (h *ThreadHandler) Get(w http.ResponseWriter, r *http.Request) {
	u, sid, ok := threadContext(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !threadAccountMatches(w, r, u) {
		return
	}
	thread, err := h.service.Get(r.Context(), sid, r.PathValue("threadId"), u.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, thread)
}
func (h *ThreadHandler) SetArchived(w http.ResponseWriter, r *http.Request) {
	u, sid, ok := threadContext(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !threadAccountMatches(w, r, u) {
		return
	}
	var body struct {
		Archived bool `json:"archived"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil || strings.TrimSpace(r.PathValue("threadId")) == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	thread, err := h.service.SetArchived(r.Context(), sid, r.PathValue("threadId"), u.ID, body.Archived)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, thread)
}
