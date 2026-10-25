package handlers

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// The body permits 10,000 Unicode code points (up to 40 KiB as UTF-8), and
// JSON escaping can expand those bytes. Keep a separate bounded wire limit.
const emailCampaignRequestMaxBytes = 128 << 10

// EmailCampaignHandler must only be mounted behind routeDeps.authAdmin. The
// actor ID captured here is audit provenance, not an authorization check.
type EmailCampaignHandler struct{ service services.EmailCampaignService }

func NewEmailCampaignHandler(service services.EmailCampaignService) *EmailCampaignHandler {
	return &EmailCampaignHandler{service: service}
}

func (h *EmailCampaignHandler) actor(w http.ResponseWriter, r *http.Request) (string, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || strings.TrimSpace(user.ID) == "" {
		pkg.Error(w, pkg.ErrUnauthorized)
		return "", false
	}
	return user.ID, true
}

func decodeEmailCampaignBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.ContentLength > emailCampaignRequestMaxBytes {
		pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "campaign request is too large", "PAYLOAD_TOO_LARGE")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, emailCampaignRequestMaxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "campaign request is too large", "PAYLOAD_TOO_LARGE")
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

func (h *EmailCampaignHandler) CreateDraft(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.actor(w, r)
	if !ok {
		return
	}
	var request models.CreateEmailCampaignRequest
	if !decodeEmailCampaignBody(w, r, &request) {
		return
	}
	campaign, err := h.service.CreateDraft(r.Context(), adminID, &request)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, campaign)
}

func (h *EmailCampaignHandler) Preview(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.actor(w, r); !ok {
		return
	}
	id := r.PathValue("id")
	if !validEmailCampaignID(id) {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	preview, err := h.service.Preview(r.Context(), id)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, preview)
}

func (h *EmailCampaignHandler) Publish(w http.ResponseWriter, r *http.Request) {
	adminID, ok := h.actor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !validEmailCampaignID(id) {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	campaign, err := h.service.Publish(r.Context(), adminID, id)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, campaign)
}

func validEmailCampaignID(id string) bool {
	if len(id) != 35 || !strings.HasPrefix(id, "ec_") {
		return false
	}
	decoded, err := hex.DecodeString(id[3:])
	return err == nil && len(decoded) == 16
}
