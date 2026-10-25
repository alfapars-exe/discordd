package handlers

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func decodeApplicationBody(w http.ResponseWriter, r *http.Request, limit int64, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(dst) != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	return true
}

func requestUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return nil, false
	}
	return user, true
}

func (h *BotHandler) PutManifest(w http.ResponseWriter, r *http.Request) {
	owner, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	var body struct {
		Description string                     `json:"description"`
		TestMode    bool                       `json:"test_mode"`
		Actions     []models.ApplicationAction `json:"actions"`
	}
	if !decodeApplicationBody(w, r, 32<<10, &body) {
		return
	}
	manifest, err := h.svc.PutApplicationManifest(r.Context(), owner.ID, r.PathValue("botID"), body.Description, body.TestMode, body.Actions)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, manifest)
}

func (h *BotHandler) ListManifests(w http.ResponseWriter, r *http.Request) {
	owner, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	items, err := h.svc.ListOwnedApplicationManifests(r.Context(), owner.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"applications": items})
}

func (h *BotHandler) Install(w http.ResponseWriter, r *http.Request) {
	actor, ok := requestUser(w, r)
	if !ok {
		return
	}
	var body struct {
		Scopes []string `json:"scopes"`
	}
	if !decodeApplicationBody(w, r, 4<<10, &body) {
		return
	}
	item, err := h.svc.InstallApplication(r.Context(), actor.ID, r.PathValue("serverId"), r.PathValue("botID"), body.Scopes)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, item)
}

func (h *BotHandler) ListInstallations(w http.ResponseWriter, r *http.Request) {
	items, err := h.svc.ListApplicationInstallations(r.Context(), r.PathValue("serverId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"applications": items})
}

func (h *BotHandler) ListAvailableActions(w http.ResponseWriter, r *http.Request) {
	items, err := h.svc.ListAvailableApplicationActions(r.Context(), r.PathValue("serverId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"actions": items})
}

func (h *BotHandler) RevokeInstallation(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RevokeApplicationInstallation(r.Context(), r.PathValue("serverId"), r.PathValue("botID")); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *BotHandler) InvokeAction(w http.ResponseWriter, r *http.Request) {
	actor, ok := requestUser(w, r)
	if !ok || actor.IsBot {
		if ok {
			pkg.Error(w, pkg.ErrForbidden)
		}
		return
	}
	invocation, err := h.svc.InvokeApplicationAction(r.Context(), actor.ID, r.PathValue("serverId"), r.PathValue("channelId"), r.PathValue("messageId"), r.PathValue("actionId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusAccepted, invocation)
}

func (h *BotHandler) InvokeTest(w http.ResponseWriter, r *http.Request) {
	owner, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	invocation, err := h.svc.InvokeApplicationTest(r.Context(), owner.ID, r.PathValue("botID"), r.PathValue("actionId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusAccepted, invocation)
}

func (h *BotHandler) GetInvocation(w http.ResponseWriter, r *http.Request) {
	actor, ok := authenticatedHuman(w, r)
	if !ok {
		return
	}
	invocation, err := h.svc.GetApplicationInvocation(r.Context(), actor.ID, r.PathValue("invocationId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, invocation)
}

func (h *BotHandler) CompleteInvocation(w http.ResponseWriter, r *http.Request) {
	bot, ok := requestUser(w, r)
	if !ok {
		return
	}
	if !bot.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return
	}
	var body struct {
		Status     string  `json:"status"`
		ResultText *string `json:"result_text"`
		ErrorCode  *string `json:"error_code"`
	}
	if !decodeApplicationBody(w, r, 8<<10, &body) {
		return
	}
	if err := h.svc.CompleteApplicationInvocation(r.Context(), bot.ID, r.PathValue("invocationId"), body.Status, body.ResultText, body.ErrorCode); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
