package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// PreferencesHandler handles GET/PATCH /api/users/me/preferences.
type PreferencesHandler struct {
	svc services.PreferencesService
}

// NewPreferencesHandler creates a new PreferencesHandler.
func NewPreferencesHandler(svc services.PreferencesService) *PreferencesHandler {
	return &PreferencesHandler{svc: svc}
}

// Get returns the user's preferences JSON blob.
func (h *PreferencesHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if !preferencesAccountMatches(w, user.ID, r.URL.Query().Get("expected_user_id")) {
		return
	}

	prefs, err := h.svc.Get(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, prefs)
}

// Update merges partial preferences into the user's existing preferences.
func (h *PreferencesHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdatePreferencesRequest
	// Bound the envelope as well as data itself, including whitespace and unknown
	// envelope fields. Old clients can still omit schema_version metadata.
	r.Body = http.MaxBytesReader(w, r.Body, models.MaxPreferencesPatchBytes+1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&req); err != nil {
		preferencesDecodeError(w, err)
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		preferencesDecodeError(w, err)
		return
	}
	if !preferencesAccountMatches(w, user.ID, req.ExpectedUserID) {
		return
	}

	if err := req.Validate(); err != nil {
		// err.Error() never reaches the client here: models.Validate() returns
		// a fixed, non-request-derived message (CWE-209 hardening), so the
		// response carries a static literal + the VALIDATION_FAILED code
		// instead of the raw error text.
		pkg.ErrorWithCode(w, http.StatusBadRequest, "invalid preferences data", "VALIDATION_FAILED")
		return
	}

	prefs, err := h.svc.Update(r.Context(), user.ID, req.Data)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, prefs)
}

// A refreshed cookie can belong to an account opened in another browser tab.
// Reject a stale tab's edit before calling the service, not after returning an
// acknowledgement. Older clients may omit this additive affinity assertion.
func preferencesAccountMatches(w http.ResponseWriter, authenticatedID, expectedID string) bool {
	if expectedID != "" && expectedID != authenticatedID {
		pkg.ErrorWithCode(w, http.StatusConflict, "preferences account changed", "PREFERENCES_ACCOUNT_MISMATCH")
		return false
	}
	return true
}

func preferencesDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		pkg.ErrorWithCode(w, http.StatusRequestEntityTooLarge, "preferences request too large", "PAYLOAD_TOO_LARGE")
		return
	}
	pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
}
