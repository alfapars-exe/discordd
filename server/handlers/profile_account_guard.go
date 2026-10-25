package handlers

import (
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// profileAccountUser validates the authenticated profile owner and, when
// supplied by newer clients, rejects a request bound to another account.
// Older clients may omit expected_user_id during the compatibility window.
func profileAccountUser(w http.ResponseWriter, r *http.Request) (*models.User, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || user.ID == "" {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return nil, false
	}
	if expected := r.URL.Query().Get("expected_user_id"); expected != "" && expected != user.ID {
		pkg.ErrorWithCode(w, http.StatusConflict, "profile account changed", "PROFILE_ACCOUNT_MISMATCH")
		return nil, false
	}
	return user, true
}
