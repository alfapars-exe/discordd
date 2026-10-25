package handlers

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"net/http"
	"strconv"
)

type AccountStatusHandler struct {
	repo repository.AccountStatusRepository
}

func NewAccountStatusHandler(repo repository.AccountStatusRepository) *AccountStatusHandler {
	return &AccountStatusHandler{repo: repo}
}
func (h *AccountStatusHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if user.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return
	}
	if r.URL.Query().Get("expected_user_id") != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	offset := 0
	if value := r.URL.Query().Get("offset"); value != "" {
		var err error
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > 100000 {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
	}
	if h.repo == nil {
		pkg.ErrorWithCode(w, 503, "account status unavailable", "ACCOUNT_STATUS_UNAVAILABLE")
		return
	}
	status, err := h.repo.Get(r.Context(), user.ID, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, status)
}
