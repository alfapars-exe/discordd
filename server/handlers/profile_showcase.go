package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type ProfileShowcaseHandler struct {
	service services.ProfileShowcaseService
}

func NewProfileShowcaseHandler(service services.ProfileShowcaseService) *ProfileShowcaseHandler {
	return &ProfileShowcaseHandler{service: service}
}

func showcaseScope(r *http.Request) (string, error) {
	scope := strings.TrimSpace(r.URL.Query().Get("server_id"))
	if len(scope) > 128 {
		return "", pkg.ErrBadRequest
	}
	return scope, nil
}

func (h *ProfileShowcaseHandler) Get(w http.ResponseWriter, r *http.Request) {
	u, ok := profileAccountUser(w, r)
	if !ok {
		return
	}
	scope, err := showcaseScope(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	out, err := h.service.Get(r.Context(), u.ID, scope)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, out)
}

func (h *ProfileShowcaseHandler) GetPublic(w http.ResponseWriter, r *http.Request) {
	u, _ := r.Context().Value(UserContextKey).(*models.User)
	if u == nil {
		pkg.ErrorWithCode(w, http.StatusUnauthorized, "Authentication required", "UNAUTHORIZED")
		return
	}
	scope, err := showcaseScope(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	out, err := h.service.GetPublic(r.Context(), u.ID, r.PathValue("userId"), scope)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, out)
}

func (h *ProfileShowcaseHandler) Put(w http.ResponseWriter, r *http.Request) {
	u, ok := profileAccountUser(w, r)
	if !ok {
		return
	}
	scope, err := showcaseScope(r)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if r.ContentLength > 64<<10 {
		pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "Profile document is too large", "PAYLOAD_TOO_LARGE")
		return
	}
	var body struct {
		ExpectedVersion int64                  `json:"expected_version"`
		Showcase        models.ProfileShowcase `json:"showcase"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		pkg.ErrorWithCode(w, http.StatusBadRequest, "Invalid profile document", "INVALID_BODY")
		return
	}
	out, err := h.service.Put(r.Context(), u.ID, scope, &body.Showcase, body.ExpectedVersion)
	if err != nil {
		if err == pkg.ErrConflict {
			w.Header().Set("Retry-After", strconv.Itoa(0))
			pkg.ErrorWithCode(w, http.StatusConflict, "Profile changed on another client", "VERSION_CONFLICT")
			return
		}
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, out)
}
