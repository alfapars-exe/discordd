package handlers

import (
	"net/http"
	"strconv"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// NotificationHandler serves the caller's inbox (GET/ack only — rows are
// written by the message/DM/friendship services).
type NotificationHandler struct {
	notificationService services.NotificationService
}

func NewNotificationHandler(notificationService services.NotificationService) *NotificationHandler {
	return &NotificationHandler{notificationService: notificationService}
}

// List handles GET /api/users/me/notifications?before=<id>&unread_only=1&limit=20
// limit is clamped to 1..50 (default 20); unread_only accepts "1" or "true".
func (h *NotificationHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	q := r.URL.Query()
	limit := services.NotificationPageDefault
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > services.NotificationPageMax {
		limit = services.NotificationPageMax
	}
	unreadOnly := q.Get("unread_only") == "1" || q.Get("unread_only") == "true"

	page, err := h.notificationService.List(r.Context(), user.ID, q.Get("before"), unreadOnly, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, page)
}

// Count handles GET /api/users/me/notifications/count
func (h *NotificationHandler) Count(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	n, err := h.notificationService.CountUnread(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]int{"unread_count": n})
}

// MarkAllRead handles POST /api/users/me/notifications/read-all
func (h *NotificationHandler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	marked, err := h.notificationService.MarkAllRead(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]int64{"marked": marked})
}

// MarkRead handles POST /api/users/me/notifications/{id}/read
// 404 covers both "no such row" and "not yours" — the service does not
// distinguish them, so an ID cannot be probed for existence.
func (h *NotificationHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.notificationService.MarkRead(r.Context(), user.ID, id); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "marked as read"})
}
