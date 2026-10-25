package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"io"
	"net/http"
	"strings"
	"time"
)

type GameJoinHandler struct {
	service   *services.GameJoinService
	auth      services.AuthService
	users     repository.UserRepository
	lifecycle repository.AccountLifecycleRepository
	limiter   *ratelimit.LoginRateLimiter
}

func NewGameJoinHandler(service *services.GameJoinService, auth services.AuthService, users repository.UserRepository, lifecycle repository.AccountLifecycleRepository) *GameJoinHandler {
	return &GameJoinHandler{service, auth, users, lifecycle, ratelimit.NewLoginRateLimiter(60, time.Minute)}
}
func (h *GameJoinHandler) allow(w http.ResponseWriter, user string) bool {
	if h.limiter == nil || !h.limiter.Allow(user) {
		w.Header().Set("Retry-After", "60")
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many game join requests")
		return false
	}
	return true
}
func (h *GameJoinHandler) identity(r *http.Request) (*models.TokenClaims, error) {
	if h == nil || h.auth == nil || h.users == nil || h.lifecycle == nil || h.service == nil {
		return nil, pkg.ErrUnauthorized
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, pkg.ErrUnauthorized
	}
	claims, e := h.auth.ValidateAccessToken(strings.TrimPrefix(header, "Bearer "))
	if e != nil {
		return nil, e
	}
	if claims.Scope != "" || claims.SessionID == "" {
		return nil, pkg.ErrUnauthorized
	}
	validator, ok := h.auth.(interface {
		ValidateSession(context.Context, string, string) error
	})
	if !ok {
		return nil, pkg.ErrUnauthorized
	}
	if e = validator.ValidateSession(r.Context(), claims.UserID, claims.SessionID); e != nil {
		return nil, e
	}
	u, e := h.users.GetByID(r.Context(), claims.UserID)
	if e != nil {
		return nil, e
	}
	if u == nil || u.IsBot || u.IsPlatformBanned || u.TokenVersion != claims.TokenVersion {
		return nil, pkg.ErrUnauthorized
	}
	state, e := h.lifecycle.Get(r.Context(), u.ID)
	if e != nil {
		return nil, e
	}
	if state == nil || state.DisabledAt != nil {
		return nil, pkg.ErrUnauthorized
	}
	return claims, nil
}
func decodeGameJoin(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	raw, e := io.ReadAll(r.Body)
	if e != nil {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(dst) != nil || d.Decode(new(any)) != io.EOF {
		pkg.Error(w, pkg.ErrBadRequest)
		return false
	}
	return true
}
func gameJoinError(w http.ResponseWriter, e error) {
	if errors.Is(e, services.ErrGameJoinExpired) {
		pkg.ErrorWithCode(w, http.StatusGone, "game join expired", "GAME_JOIN_EXPIRED")
		return
	}
	pkg.Error(w, e)
}
func (h *GameJoinHandler) Targets(w http.ResponseWriter, r *http.Request) {
	claims, e := h.identity(r)
	if e != nil {
		pkg.Error(w, e)
		return
	}
	if !h.allow(w, claims.UserID) {
		return
	}
	var req struct {
		ExpectedUserID string                     `json:"expected_user_id"`
		Targets        []services.GameJoinContext `json:"targets"`
	}
	if !decodeGameJoin(w, r, &req) {
		return
	}
	if req.ExpectedUserID != claims.UserID {
		pkg.Error(w, pkg.ErrConflict)
		return
	}
	if len(req.Targets) == 0 || len(req.Targets) > 32 {
		pkg.Error(w, pkg.ErrBadRequest)
		return
	}
	result := make([]services.GameJoinTarget, 0, len(req.Targets))
	for _, c := range req.Targets {
		if !c.Valid() {
			pkg.Error(w, pkg.ErrBadRequest)
			return
		}
		result = append(result, h.service.Target(r.Context(), claims.UserID, c))
	}
	if _, e = h.identity(r); e != nil {
		pkg.Error(w, e)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]any{"targets": result})
}
func (h *GameJoinHandler) Mint(w http.ResponseWriter, r *http.Request) {
	claims, e := h.identity(r)
	if e != nil {
		pkg.Error(w, e)
		return
	}
	if !h.allow(w, claims.UserID) {
		return
	}
	var req struct {
		services.GameJoinContext
		ExpectedUserID        string `json:"expected_user_id"`
		ExpectedOfferRevision uint64 `json:"expected_offer_revision"`
	}
	if !decodeGameJoin(w, r, &req) {
		return
	}
	if req.ExpectedUserID != claims.UserID {
		pkg.Error(w, pkg.ErrConflict)
		return
	}
	result, e := h.service.Mint(r.Context(), claims.UserID, claims.SessionID, req.GameJoinContext, req.ExpectedOfferRevision)
	if e != nil {
		gameJoinError(w, e)
		return
	}
	if _, e = h.identity(r); e != nil {
		pkg.Error(w, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkg.JSON(w, http.StatusCreated, result)
}
func (h *GameJoinHandler) Consume(w http.ResponseWriter, r *http.Request) {
	claims, e := h.identity(r)
	if e != nil {
		pkg.Error(w, e)
		return
	}
	if !h.allow(w, claims.UserID) {
		return
	}
	var req struct {
		ExpectedUserID string `json:"expected_user_id"`
		Ticket         string `json:"ticket"`
	}
	if !decodeGameJoin(w, r, &req) {
		return
	}
	if req.ExpectedUserID != claims.UserID {
		pkg.Error(w, pkg.ErrConflict)
		return
	}
	result, e := h.service.Consume(r.Context(), claims.UserID, claims.SessionID, req.Ticket)
	if e != nil {
		gameJoinError(w, e)
		return
	}
	if _, e = h.identity(r); e != nil {
		pkg.Error(w, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkg.JSON(w, http.StatusOK, result)
}
