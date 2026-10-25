package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

const serverEventBodyMaxBytes = 16 << 10

type ServerEventHandler struct{ service services.ServerEventService }

func NewServerEventHandler(service services.ServerEventService) *ServerEventHandler {
	return &ServerEventHandler{service: service}
}

func (h *ServerEventHandler) requestActor(w http.ResponseWriter, r *http.Request) (*models.User, string, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || strings.TrimSpace(user.ID) == "" {
		pkg.Error(w, pkg.ErrUnauthorized)
		return nil, "", false
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || strings.TrimSpace(serverID) == "" {
		pkg.Error(w, pkg.ErrBadRequest)
		return nil, "", false
	}
	values := r.URL.Query()["expected_user_id"]
	if len(values) > 1 || (len(values) == 1 && (len(values[0]) > 128 || values[0] != user.ID)) {
		pkg.ErrorWithCode(w, http.StatusConflict, "account changed; reload before continuing", "SERVER_EVENT_ACCOUNT_MISMATCH")
		return nil, "", false
	}
	return user, serverID, true
}

func decodeServerEventBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.ContentLength > serverEventBodyMaxBytes {
		pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "event request is too large", "PAYLOAD_TOO_LARGE")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, serverEventBodyMaxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "event request is too large", "PAYLOAD_TOO_LARGE")
		} else {
			pkg.Error(w, pkg.ErrBadRequest)
		}
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	return true
}

func (h *ServerEventHandler) List(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	limit := 50
	if values, exists := r.URL.Query()["limit"]; exists {
		if len(values) != 1 {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
		parsed, err := strconv.Atoi(values[0])
		if err != nil || parsed < 1 || parsed > 100 {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
		limit = parsed
	}
	beforeID := strings.TrimSpace(r.URL.Query().Get("before_id"))
	if len(beforeID) > 128 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	events, err := h.service.List(r.Context(), serverID, user.ID, limit, beforeID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"events": events})
}

func (h *ServerEventHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	eventID := strings.TrimSpace(r.PathValue("eventId"))
	if eventID == "" || len(eventID) > 128 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	event, err := h.service.Get(r.Context(), serverID, eventID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, event)
}

func (h *ServerEventHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	var body models.CreateServerEventRequest
	if !decodeServerEventBody(w, r, &body) {
		return
	}
	event, err := h.service.Create(r.Context(), serverID, user.ID, &body)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, event)
}

func (h *ServerEventHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	eventID := strings.TrimSpace(r.PathValue("eventId"))
	if eventID == "" || len(eventID) > 128 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	var body models.UpdateServerEventRequest
	if !decodeServerEventBody(w, r, &body) {
		return
	}
	event, err := h.service.Update(r.Context(), serverID, eventID, user.ID, &body)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, event)
}

func (h *ServerEventHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	eventID := strings.TrimSpace(r.PathValue("eventId"))
	if eventID == "" || len(eventID) > 128 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	var body struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if !decodeServerEventBody(w, r, &body) {
		return
	}
	if body.ExpectedVersion < 1 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	event, err := h.service.Cancel(r.Context(), serverID, eventID, user.ID, body.ExpectedVersion)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, event)
}

func (h *ServerEventHandler) RSVP(w http.ResponseWriter, r *http.Request) {
	user, serverID, ok := h.requestActor(w, r)
	if !ok {
		return
	}
	eventID := strings.TrimSpace(r.PathValue("eventId"))
	if eventID == "" || len(eventID) > 128 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	var body struct {
		Interested *bool `json:"interested"`
	}
	if !decodeServerEventBody(w, r, &body) {
		return
	}
	if body.Interested == nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	if err := h.service.SetInterested(r.Context(), serverID, eventID, user.ID, *body.Interested); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]bool{"interested": *body.Interested})
}
