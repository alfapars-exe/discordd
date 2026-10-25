package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type authSessionManager interface {
	ListSessions(context.Context, string, string) ([]models.AuthSession, error)
	RevokeSession(context.Context, string, string, string, string, string) error
	RevokeOtherSessions(context.Context, string, string, string, string) (int, error)
}

func sessionActor(w http.ResponseWriter, r *http.Request) (*models.User, string, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return nil, "", false
	}
	if user.IsBot {
		pkg.Error(w, pkg.ErrForbidden)
		return nil, "", false
	}
	sid, _ := r.Context().Value(AuthSessionContextKey).(string)
	if sid == "" {
		pkg.ErrorWithCode(w, 401, "session upgrade required; refresh your sign-in", "SESSION_UPGRADE_REQUIRED")
		return nil, "", false
	}
	return user, sid, true
}

func (h *AuthHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, sid, ok := sessionActor(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Get("expected_user_id") != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	manager, ok := h.authService.(authSessionManager)
	if !ok {
		pkg.ErrorWithCode(w, 503, "session management unavailable", "SESSIONS_UNAVAILABLE")
		return
	}
	list, err := manager.ListSessions(r.Context(), user.ID, sid)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, 200, map[string]any{"sessions": list, "current_session_id": sid})
}

func (h *AuthHandler) RevokeSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, sid, ok := sessionActor(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedUserID string `json:"expected_user_id"`
		Password       string `json:"password"`
		Code           string `json:"code"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithCode(w, 400, "invalid request body", "VALIDATION_FAILED")
		return
	}
	if req.ExpectedUserID != user.ID {
		pkg.ErrorWithCode(w, 409, "account changed; sign in again", "ACCOUNT_MISMATCH")
		return
	}
	manager, ok := h.authService.(authSessionManager)
	if !ok {
		pkg.ErrorWithCode(w, 503, "session management unavailable", "SESSIONS_UNAVAILABLE")
		return
	}
	target := r.PathValue("sessionId")
	var err error
	count := 1
	if target == "others" {
		count, err = manager.RevokeOtherSessions(r.Context(), user.ID, sid, req.Password, req.Code)
	} else {
		err = manager.RevokeSession(r.Context(), user.ID, sid, target, req.Password, req.Code)
	}
	if err != nil {
		if !writeMFAError(w, err) {
			pkg.Error(w, err)
		}
		return
	}
	// No Set-Cookie: a different tab may already have replaced the cookie.
	pkg.JSON(w, 200, map[string]any{"revoked_count": count, "current_revoked": target == sid})
}
