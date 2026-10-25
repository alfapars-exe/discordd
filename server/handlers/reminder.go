package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type ReminderHandler struct{ service services.ReminderService }

func NewReminderHandler(s services.ReminderService) *ReminderHandler {
	return &ReminderHandler{service: s}
}
func reminderUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	u, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return nil, false
	}
	if expected := r.URL.Query().Get("expected_user_id"); expected != "" && expected != u.ID {
		pkg.ErrorWithCode(w, http.StatusConflict, "reminder account changed", "REMINDER_ACCOUNT_MISMATCH")
		return nil, false
	}
	return u, ok
}
func (h *ReminderHandler) List(w http.ResponseWriter, r *http.Request) {
	u, ok := reminderUser(w, r)
	if !ok {
		return
	}
	v, err := h.service.List(r.Context(), u.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"reminders": v})
}
func (h *ReminderHandler) Create(w http.ResponseWriter, r *http.Request) {
	u, ok := reminderUser(w, r)
	if !ok {
		return
	}
	var req models.CreateMessageReminderRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	v, err := h.service.Create(r.Context(), u.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, v)
}
func (h *ReminderHandler) Update(w http.ResponseWriter, r *http.Request) {
	u, ok := reminderUser(w, r)
	if !ok {
		return
	}
	var req models.UpdateMessageReminderRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	v, err := h.service.Update(r.Context(), u.ID, r.PathValue("id"), req.DueAt)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, v)
}
func (h *ReminderHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	u, ok := reminderUser(w, r)
	if !ok {
		return
	}
	if err := h.service.Cancel(r.Context(), u.ID, r.PathValue("id")); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "reminder cancelled"})
}
