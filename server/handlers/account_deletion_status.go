package handlers

import (
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"net/http"
	"strconv"
)

type AccountDeletionStatusHandler struct {
	repo repository.AccountDeletionStatusRepository
}

func NewAccountDeletionStatusHandler(repo repository.AccountDeletionStatusRepository) *AccountDeletionStatusHandler {
	return &AccountDeletionStatusHandler{repo: repo}
}
func (h *AccountDeletionStatusHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, _, ok := sessionActor(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Get("expected_user_id") != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 100000 {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
		offset = n
	}
	if h.repo == nil {
		pkg.ErrorWithCode(w, 503, "deletion checks unavailable", "ACCOUNT_DELETION_UNAVAILABLE")
		return
	}
	result, err := h.repo.Get(r.Context(), user.ID, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, result)
}
