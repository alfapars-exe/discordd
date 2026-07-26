// Package handlers — audit_log: read-only endpoint backing the audit channel UI.
//
// GET /api/servers/{id}/audit?limit=50&before=<RFC3339 timestamp>&before_id=<id>
//
// Returns a server's audit log entries, paginated by a keyset cursor on
// (created_at, id). `before`+`before_id` are the last row the client holds.
// Permission is enforced inside audit_log_service.List — the user must
// have PermAdmin OR any of Kick/Ban/Mute/Deafen members on the server.
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type AuditLogHandler struct {
	svc services.AuditLogService
}

func NewAuditLogHandler(svc services.AuditLogService) *AuditLogHandler {
	return &AuditLogHandler{svc: svc}
}

// ListServerAudit handles GET /api/servers/{id}/audit.
func (h *AuditLogHandler) ListServerAudit(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID := r.PathValue("serverId")
	if serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "missing server id")
		return
	}

	// Optional pagination params. `before` is an RFC3339 timestamp and
	// `before_id` the matching row id — together they form the keyset cursor;
	// older rows are returned. `before_id` is optional (older clients omit it,
	// falling back to the created_at-only cursor). `limit` is clamped inside
	// the service.
	filter := models.AuditLogFilter{
		ServerID: serverID,
		Limit:    50,
	}
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			filter.Limit = n
		}
	}
	if b := r.URL.Query().Get("before"); b != "" {
		if t, err := time.Parse(time.RFC3339Nano, b); err == nil {
			filter.Before = &t
		}
	}
	if bid := r.URL.Query().Get("before_id"); bid != "" {
		filter.BeforeID = &bid
	}

	entries, err := h.svc.List(r.Context(), user.ID, filter)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Wrap in a struct so we can extend the response later (e.g. add
	// has_more, next_cursor) without breaking clients that already parse
	// just `entries`.
	resp := struct {
		Entries []models.AuditLog `json:"entries"`
	}{Entries: entries}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
