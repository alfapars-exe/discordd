package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type applicationGameGrantService interface {
	RegisterGameIdentity(context.Context, string, string) (*models.ApplicationGameIdentity, error)
	ListGameGrants(context.Context, string) ([]models.ApplicationGameGrant, error)
	ChangeGameGrant(context.Context, string, string, int64, bool, bool) (*models.ApplicationGameGrant, error)
}

func (h *BotHandler) gameGrants(w http.ResponseWriter) (applicationGameGrantService, bool) {
	svc, ok := h.svc.(applicationGameGrantService)
	if !ok {
		pkg.Error(w, pkg.ErrInternal)
	}
	return svc, ok
}

func (h *BotHandler) RegisterGameIdentity(w http.ResponseWriter, r *http.Request) {
	user, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	svc, ok := h.gameGrants(w)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body struct{}
	if err := decoder.Decode(&body); err != io.EOF {
		if err != nil || decoder.Decode(new(any)) != io.EOF {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
	}
	// No client-supplied kind, publisher trust, target owner or first-party flag.
	identity, err := svc.RegisterGameIdentity(r.Context(), user.ID, r.PathValue("botID"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, identity)
}
func (h *BotHandler) ListGameGrants(w http.ResponseWriter, r *http.Request) {
	user, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	svc, ok := h.gameGrants(w)
	if !ok {
		return
	}
	items, err := svc.ListGameGrants(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"grants": items})
}
func (h *BotHandler) PutGameGrant(w http.ResponseWriter, r *http.Request) {
	h.changeGameGrant(w, r, false)
}
func (h *BotHandler) RevokeGameGrant(w http.ResponseWriter, r *http.Request) {
	h.changeGameGrant(w, r, true)
}
func (h *BotHandler) changeGameGrant(w http.ResponseWriter, r *http.Request, revoke bool) {
	user, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	svc, ok := h.gameGrants(w)
	if !ok {
		return
	}
	var body struct {
		ExpectedRevision *int64 `json:"expected_revision"`
		MessagingEnabled *bool  `json:"messaging_enabled,omitempty"`
	}
	if !decodeApplicationBody(w, r, 2<<10, &body) {
		return
	}
	if body.ExpectedRevision == nil || (!revoke && body.MessagingEnabled == nil) || (revoke && body.MessagingEnabled != nil) {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	enabled := false
	if body.MessagingEnabled != nil {
		enabled = *body.MessagingEnabled
	}
	item, err := svc.ChangeGameGrant(r.Context(), user.ID, r.PathValue("botID"), *body.ExpectedRevision, enabled, revoke)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, item)
}
